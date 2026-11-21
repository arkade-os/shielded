package io.arkade.shielded.platform

import android.security.keystore.KeyProperties.AUTH_BIOMETRIC_STRONG
import android.security.keystore.KeyProperties.AUTH_DEVICE_CREDENTIAL
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import org.junit.Assert.*
import org.junit.Test

class AndroidLockPolicyTest {
    @Test fun everySdkRequiresAuthSurvivesNewFingerprintsAndAllowsThePin() {
        for (sdk in listOf(24, 29, 30, 36)) {
            val spec = AndroidLockPolicy.keySpec(sdk)
            assertTrue("SDK $sdk", spec.authRequired)
            assertFalse("SDK $sdk", spec.invalidatedByEnrollment)
            assertEquals("SDK $sdk key", AUTH_DEVICE_CREDENTIAL, spec.keyAuth and AUTH_DEVICE_CREDENTIAL)
            assertEquals("SDK $sdk prompt", DEVICE_CREDENTIAL, spec.authenticators and DEVICE_CREDENTIAL)
        }
    }

    @Test fun sdk30AndUpAuthenticatesEachUseAndAllowsThePin() {
        for (sdk in listOf(30, 36))
            assertEquals(LockKeySpec(true, false, LockMode.PER_USE, 0, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL,
                BIOMETRIC_STRONG or DEVICE_CREDENTIAL), AndroidLockPolicy.keySpec(sdk))
    }

    @Test fun olderSdksUseAShortWindowAndAllowThePin() {
        for (sdk in listOf(24, 29))
            assertEquals(LockKeySpec(true, false, LockMode.WINDOW, 10, AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL,
                BIOMETRIC_WEAK or DEVICE_CREDENTIAL), AndroidLockPolicy.keySpec(sdk))
    }

    @Test fun aKeyOpensTheWayItWasMadeAfterAnOsUpdate() {
        for (sdk in listOf(24, 29, 30, 36)) assertEquals("SDK $sdk", LockMode.WINDOW, AndroidLockPolicy.unlockPath("WINDOW", sdk))
        for (sdk in listOf(30, 36)) assertEquals("SDK $sdk", LockMode.PER_USE, AndroidLockPolicy.unlockPath("PER_USE", sdk))
    }

    @Test fun anUnknownOrMissingModeFailsClosed() {
        for (stored in listOf(null, "", "window", "BOTH"))
            assertTrue("$stored", assertThrows(IllegalStateException::class.java) { AndroidLockPolicy.unlockPath(stored, 36) }.message!!.contains("mode"))
        assertThrows(IllegalStateException::class.java) { AndroidLockPolicy.unlockPath("PER_USE", 29) }
    }

    @Test fun aDismissedPromptIsACancelAndAFailedOneIsNot() {
        for (code in listOf(BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED,
            BiometricPrompt.ERROR_TIMEOUT, BiometricPrompt.ERROR_NEGATIVE_BUTTON)) assertTrue("$code", AndroidLockPolicy.cancelled(code))
        for (code in listOf(BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
            BiometricPrompt.ERROR_HW_UNAVAILABLE)) assertFalse("$code", AndroidLockPolicy.cancelled(code))
    }

    @Test fun aPlainEntryWinsOverALockedOne() {
        assertEquals("plain", AndroidLockPolicy.vaultKind(plain = true, locked = true))
        assertEquals("plain", AndroidLockPolicy.vaultKind(plain = true, locked = false))
        assertEquals("locked", AndroidLockPolicy.vaultKind(plain = false, locked = true))
        assertEquals("none", AndroidLockPolicy.vaultKind(plain = false, locked = false))
    }
}
