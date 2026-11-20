package io.arkade.shielded.platform

import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt

internal data class LockKeySpec(val authRequired: Boolean, val invalidatedByEnrollment: Boolean, val perUse: Boolean,
    val validitySeconds: Int, val authenticators: Int)

// Only compile-time constants from androidx, so the JVM unit tests need no Android runtime.
internal object AndroidLockPolicy {
    // Below API 30 androidx refuses a CryptoObject with the PIN, and BIOMETRIC_STRONG with the PIN on 28-29.
    fun keySpec(sdk: Int) =
        if (sdk >= 30) LockKeySpec(true, false, true, 0, BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        else LockKeySpec(true, false, false, 10, BIOMETRIC_WEAK or DEVICE_CREDENTIAL)

    fun cancelled(error: Int) = error in setOf(BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_TIMEOUT)

    fun vaultKind(plain: Boolean, locked: Boolean) = if (plain) "plain" else if (locked) "locked" else "none"
}
