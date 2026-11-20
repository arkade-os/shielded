package io.arkade.shielded.platform

import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import org.junit.Assert.*
import org.junit.Test

class AndroidLockPolicyTest {
    @Test fun everySdkRequiresAuthAndSurvivesNewFingerprints() {
        for (sdk in listOf(24, 29, 30, 36)) {
            val spec = AndroidLockPolicy.keySpec(sdk)
            assertTrue("SDK $sdk", spec.authRequired)
            assertFalse("SDK $sdk", spec.invalidatedByEnrollment)
        }
    }

    @Test fun sdk30AndUpAuthenticatesEachUseAndAllowsThePin() {
        for (sdk in listOf(30, 36))
            assertEquals(LockKeySpec(true, false, true, 0, BIOMETRIC_STRONG or DEVICE_CREDENTIAL), AndroidLockPolicy.keySpec(sdk))
    }

    @Test fun olderSdksUseAShortWindowAndAllowThePin() {
        for (sdk in listOf(24, 29))
            assertEquals(LockKeySpec(true, false, false, 10, BIOMETRIC_WEAK or DEVICE_CREDENTIAL), AndroidLockPolicy.keySpec(sdk))
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
