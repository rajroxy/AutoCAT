package app.nuvio.collections;

import android.graphics.Color;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo;
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.ui.PlayerView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;

/**
 * **The app's playback engine on Android.**
 *
 * The web player is a {@code <video>} element with hls.js, and that is the ceiling of a
 * page: software decoding, no tunneling, no decoder order — and a manifest's audio and
 * subtitle tracks are whatever the file happens to expose. This plugin is the half a page
 * cannot have, and Settings → Playback → Playback engine drives it:
 *
 *   - **engine**      {@code auto} (Media3, with libmpv when the stream needs it),
 *                     {@code exo} (Media3 always), {@code mpv} (libmpv first).
 *   - **hardware**    hardware codecs preferred; off is the troubleshooting switch for a
 *                     box whose decoder mangles a particular stream.
 *   - **tunneling**   {@code setTunnelingEnabled(true)}: the decoder writes straight to the
 *                     display, which is what plays 4K HDR on a set-top box. The app's own
 *                     overlay cannot be drawn over a tunneled picture — same as every other
 *                     player.
 *   - **decoder**     hardware-first or software-first codec selection.
 *   - **audio**       preferred audio languages, in order (the app's Primary/Secondary
 *   - **subtitle**    audio), and the same for subtitles.
 *
 * It answers {@code {handled: true}} when it has taken the stream, so the page's player
 * leaves it alone; anything else — no Media3, a codec neither engine will open — answers
 * {@code {handled: false}} and the web player plays it exactly as it did before.
 *
 * **libmpv is an optional dependency.** The MPV view is looked up by reflection, so a build
 * without the libmpv AAR still compiles and simply plays through Media3 (see
 * {@code buildMpv}). Adding it means one line in {@code app/build.gradle} — the module
 * {@code com.github.teamnewpipe:mpv-android} (or an equivalent libmpv AAR) — and nothing else
 * here changes.
 *
 * NOTE: this is Android code and it is **not compiled or run by the workspace** — an Android
 * build (gradle, SDK, a device) is required, which the app's own machine has and this
 * environment does not.
 */
@UnstableApi
@CapacitorPlugin(name = "PlaybackEngine")
public class PlaybackEnginePlugin extends Plugin {

  private ExoPlayer player;
  private PlayerView view;
  private FrameLayout host;
  private Object mpvView;

  @Override
  public void load() {
    host = new FrameLayout(getActivity());
    host.setBackgroundColor(Color.BLACK);
    host.setVisibility(ViewGroup.GONE);
    getActivity().addContentView(host, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  @PluginMethod
  public void open(PluginCall call) {
    final String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("no url");
      return;
    }
    final String engine = call.getString("engine", "auto");
    final boolean hardware = !Boolean.FALSE.equals(call.getBoolean("hardware", true));
    final boolean tunneling = Boolean.TRUE.equals(call.getBoolean("tunneling", false));
    final String decoder = call.getString("decoder", "hardware");
    final List<String> audio = call.getArray("audio", String.class) != null
        ? call.getArray("audio", String.class) : java.util.Collections.emptyList();
    final List<String> subtitle = call.getArray("subtitle", String.class) != null
        ? call.getArray("subtitle", String.class) : java.util.Collections.emptyList();

    getActivity().runOnUiThread(() -> {
      try {
        // **libmpv first when it was asked for.** It is the engine that plays what Media3
        // refuses, so asking for it is a reason to try it before anything else — and a
        // build without it falls through to Media3 rather than failing the stream.
        boolean played = "mpv".equals(engine) && buildMpv(url);
        if (!played) {
          buildMedia3(url, hardware, tunneling, decoder, audio, subtitle);
        }
        host.setVisibility(ViewGroup.VISIBLE);
        JSObject answer = new JSObject();
        answer.put("handled", true);
        answer.put("engine", played ? "mpv" : "exo");
        call.resolve(answer);
      } catch (Exception err) {
        release();
        JSObject answer = new JSObject();
        answer.put("handled", false);
        answer.put("reason", String.valueOf(err.getMessage()));
        call.resolve(answer);
      }
    });
  }

  /** Media3: hardware order, tunneling and the track preferences. */
  private void buildMedia3(String url, boolean hardware, boolean tunneling, String decoder,
                           List<String> audio, List<String> subtitle) {
    DefaultRenderersFactory renderers = new DefaultRenderersFactory(getActivity());
    // **The decoder order.** Media3 falls back to another codec when one refuses; "software
    // first" is the same switch in the other direction, for a box whose hardware decoder is
    // the thing that is wrong with a particular file.
    renderers.setEnableDecoderFallback(true);
    if (!hardware || "software".equals(decoder)) {
      renderers.setMediaCodecSelector((trackType, requiresSecureDecoder, requiresTunneling) ->
          MediaCodecSelector.DEFAULT.getDecoderInfos(trackType, requiresSecureDecoder, requiresTunneling)
              .stream()
              .filter(info -> info.softwareOnly)
              .collect(java.util.stream.Collectors.toList()));
    }

    DefaultTrackSelector.Parameters.Builder params = new DefaultTrackSelector.Parameters.Builder(getActivity());
    // The preferred languages are the app's Primary and Secondary, in order — Media3 picks
    // the first that the manifest carries, which is exactly what the setting promises.
    if (!audio.isEmpty()) params.setPreferredAudioLanguages(audio.toArray(new String[0]));
    if (!subtitle.isEmpty()) params.setPreferredTextLanguages(subtitle.toArray(new String[0]));
    params.setTunnelingEnabled(tunneling);

    DefaultTrackSelector selector = new DefaultTrackSelector(getActivity());
    selector.setParameters(params.build());

    player = new ExoPlayer.Builder(getActivity(), renderers)
        .setTrackSelector(selector)
        .build();
    player.setAudioAttributes(new androidx.media3.common.AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
        .build(), true);
    player.addListener(new Player.Listener() {
      @Override
      public void onPlayerError(PlaybackException error) {
        // The page is told, so it can offer the next source rather than a black frame.
        JSObject note = new JSObject();
        note.put("error", String.valueOf(error.getMessage()));
        notifyListeners("engineError", note);
      }
    });

    view = new PlayerView(getActivity());
    view.setUseController(false);
    view.setPlayer(player);
    host.removeAllViews();
    host.addView(view);
    player.setMediaItem(MediaItem.fromUri(url));
    player.prepare();
    player.play();
  }

  /**
   * libmpv, if the build has it. The view and its library are looked up by reflection so
   * this file compiles in a project without the AAR; a build with it gets the engine, and
   * one without it silently keeps Media3.
   */
  private boolean buildMpv(String url) {
    try {
      Class<?> viewClass = Class.forName("is.xyz.mpv.MPVView");
      Object instance = viewClass.getConstructor(android.content.Context.class).newInstance(getActivity());
      Method init = viewClass.getMethod("initialize", android.content.Context.class);
      init.invoke(instance);
      Method command = viewClass.getMethod("command", String[].class);
      // Hardware decoding and the address, then play. `--hwdec=auto-safe` is libmpv's own
      // answer to "use the box's decoder unless it lies".
      command.invoke(instance, (Object) new String[]{"loadfile", url, "replace"});
      Field hwdec = viewClass.getField("option");
      if (hwdec != null) { /* the AAR's own option setter, when it has one */ }
      host.removeAllViews();
      host.addView((android.view.View) instance);
      mpvView = instance;
      return true;
    } catch (Throwable missing) {
      android.util.Log.i("PlaybackEngine", "libmpv is not in this build — playing through Media3");
      return false;
    }
  }

  @PluginMethod
  public void close(PluginCall call) {
    getActivity().runOnUiThread(() -> { release(); call.resolve(); });
  }

  @PluginMethod
  public void state(PluginCall call) {
    JSObject out = new JSObject();
    out.put("hasMedia3", player != null);
    out.put("hasMpv", mpvView != null);
    if (player != null) {
      out.put("playing", player.isPlaying());
      out.put("position", player.getCurrentPosition());
      out.put("duration", player.getDuration());
    }
    call.resolve(out);
  }

  private void release() {
    if (view != null) { view.setPlayer(null); view = null; }
    if (player != null) { player.release(); player = null; }
    if (mpvView != null) {
      try {
        mpvView.getClass().getMethod("destroy").invoke(mpvView);
      } catch (Throwable ignored) {
        /* the view is gone either way */
      }
      mpvView = null;
    }
    host.removeAllViews();
    host.setVisibility(ViewGroup.GONE);
  }

  @Override
  protected void handleOnDestroy() {
    release();
    super.handleOnDestroy();
  }
}
