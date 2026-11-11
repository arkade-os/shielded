package io.arkade.shielded.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        runCatching { AndroidUpdater(context).receive(intent) }
    }
}
