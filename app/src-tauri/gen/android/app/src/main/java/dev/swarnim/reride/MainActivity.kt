package dev.swarnim.reride

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // The manifest handles uiMode changes without recreating the activity, so re-apply the system-bar
  // style ourselves; otherwise status-bar icons keep the old (invisible) colour after a light/dark switch.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    enableEdgeToEdge()
  }
}
