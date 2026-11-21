package io.arkade.shielded.platform

import android.security.keystore.KeyProperties.AUTH_BIOMETRIC_STRONG
import android.security.keystore.KeyProperties.AUTH_DEVICE_CREDENTIAL
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt

// Stored by name in the locked record, so the names are permanent.
internal enum class LockMode { PER_USE, WINDOW }

internal data class LockKeySpec(val authRequired: Boolean, val invalidatedByEnrollment: Boolean, val mode: LockMode,
    val validitySeconds: Int, val keyAuth: Int, val authenticators: Int)

// Only compile-time constants from androidx and android.jar, so the JVM unit tests need no Android runtime.
internal object AndroidLockPolicy {
    // Below API 30 androidx refuses a CryptoObject with the PIN, and BIOMETRIC_STRONG with the PIN on 28-29.
    // A key made there takes no auth types: its validity window implies keyAuth's two.
    fun keySpec(sdk: Int) =
        if (sdk >= 30) LockKeySpec(true, false, LockMode.PER_USE, 0, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL, BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        else LockKeySpec(true, false, LockMode.WINDOW, 10, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL, BIOMETRIC_WEAK or DEVICE_CREDENTIAL)

    // The key's own mode, not today's SDK: after an OS update to API 30 a window key still needs the window path.
    fun unlockPath(stored: String?, sdk: Int): LockMode {
        val mode = LockMode.entries.find { it.name == stored } ?: error("The locked wallet's device-lock mode is unknown.")
        check(mode == LockMode.WINDOW || sdk >= 30) { "A per-use device-lock mode needs API 30." }
        return mode
    }

    fun cancelled(error: Int) = error in setOf(BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT)

    fun vaultKind(plain: Boolean, locked: Boolean) = if (plain) "plain" else if (locked) "locked" else "none"
}
