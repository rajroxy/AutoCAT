package app.autocat.collections;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // **The playback engine is one of this app's own plugins.** Registering it here is what
    // makes `window.Capacitor.Plugins.PlaybackEngine` exist in the page, which is how the
    // player knows it can hand a stream to Media3 or libmpv instead of the element. See
    // PlaybackEnginePlugin.
    registerPlugin(PlaybackEnginePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
