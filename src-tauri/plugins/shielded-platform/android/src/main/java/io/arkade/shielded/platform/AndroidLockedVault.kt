package io.arkade.shielded.platform

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal const val LOCK_CANCELLED = "cancelled"
internal const val LOCK_GONE = "lock-gone"

internal class LockFailure(code: String) : Exception(code)

class AndroidLockedVault(context: Context) {
    companion object {
        private val access = Any()
    }

    private val records = context.getSharedPreferences("shielded_locked_v1", Context.MODE_PRIVATE)
    private val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    private val alias = "io.arkade.shielded.locked.v1"
    private val aad = alias.toByteArray(Charsets.UTF_8)
    private val spec = AndroidLockPolicy.keySpec(Build.VERSION.SDK_INT)
    private val main = Handler(Looper.getMainLooper())

    fun available() = keyguard.isDeviceSecure

    fun exists() = synchronized(access) { records.contains("entropy") }

    fun get(host: () -> FragmentActivity?, live: () -> Boolean): String? = synchronized(access) {
        val encoded = records.getString("entropy", null) ?: return@synchronized null
        check(encoded.length <= 128)
        val blob = Base64.decode(encoded, Base64.NO_WRAP)
        check((blob.size == 61 || blob.size == 93) && blob[0] == 1.toByte())
        // Removing the screen lock invalidates every lock-bound key, and some Android versions delete them: the blob can never open.
        if (!available()) throw LockFailure(LOCK_GONE)
        val key = store().getKey(alias, null) as? SecretKey ?: throw LockFailure(LOCK_GONE)
        val lock = AndroidLockPolicy.unlockPath(records.getString("mode", null), Build.VERSION.SDK_INT)
        val cipher = unlocked(lock, Cipher.DECRYPT_MODE, key, blob.copyOfRange(1, 13), "Unlock your Shielded wallet", host, live)
        cipher.updateAAD(aad)
        val plaintext = cipher.doFinal(blob, 13, blob.size - 13)
        try {
            plaintext.toString(Charsets.UTF_8).also { requireEntropy(it) }
        } finally { plaintext.fill(0) }
    }

    fun create(value: String, host: () -> FragmentActivity?, live: () -> Boolean) = synchronized(access) {
        requireEntropy(value)
        check(available() && !records.contains("entropy"))
        val cipher = unlocked(spec.mode, Cipher.ENCRYPT_MODE, generate(), null, "Lock your Shielded wallet", host, live)
        cipher.updateAAD(aad)
        val plaintext = value.toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        check(cipher.iv.size == 12)
        val record = Base64.encodeToString(byteArrayOf(1) + cipher.iv + encrypted, Base64.NO_WRAP)
        if (!records.edit().putString("entropy", record).putString("mode", spec.mode.name).commit()) {
            records.edit().clear().commit()
            error("The locked wallet could not be stored.")
        }
    }

    fun clear() = synchronized(access) {
        check(records.edit().clear().commit())
        val store = store()
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Suppress("DEPRECATION")
    private fun generate(): SecretKey {
        val store = store()
        if (store.containsAlias(alias)) store.deleteEntry(alias)
        val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(spec.authRequired)
            .setInvalidatedByBiometricEnrollment(spec.invalidatedByEnrollment)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            builder.setUserAuthenticationParameters(spec.validitySeconds, spec.keyAuth)
        else builder.setUserAuthenticationValidityDurationSeconds(spec.validitySeconds)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(builder.build())
        return generator.generateKey()
    }

    // A window key's cipher cannot ride the prompt, so it is made again inside the key's validity window.
    private fun unlocked(lock: LockMode, mode: Int, key: SecretKey, iv: ByteArray?, title: String, host: () -> FragmentActivity?, live: () -> Boolean): Cipher {
        if (lock == LockMode.PER_USE) return cipher(mode, key, iv).also { authorize(title, it, host, live) }
        try { cipher(mode, key, iv) } catch (_: UserNotAuthenticatedException) { }
        authorize(title, null, host, live)
        return cipher(mode, key, iv)
    }

    private fun cipher(mode: Int, key: SecretKey, iv: ByteArray?): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        try {
            if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
        } catch (_: KeyPermanentlyInvalidatedException) { throw LockFailure(LOCK_GONE) }
    }

    private fun authorize(title: String, crypto: Cipher?, host: () -> FragmentActivity?, live: () -> Boolean) {
        val outcome = ArrayBlockingQueue<Result<Unit>>(1)
        var prompt: BiometricPrompt? = null
        check(main.post {
            try {
                val activity = checkNotNull(host())
                // androidx silently drops a prompt requested after onSaveInstanceState, which would never answer.
                check(!activity.supportFragmentManager.isStateSaved)
                prompt = BiometricPrompt(activity, Executor { main.post(it) }, object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        outcome.offer(Result.success(Unit))
                    }
                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        outcome.offer(Result.failure(if (AndroidLockPolicy.cancelled(code)) LockFailure(LOCK_CANCELLED) else IllegalStateException("Device lock error $code")))
                    }
                }).apply {
                    val info = BiometricPrompt.PromptInfo.Builder().setTitle(title).setAllowedAuthenticators(spec.authenticators).build()
                    if (crypto == null) authenticate(info) else authenticate(info, BiometricPrompt.CryptoObject(crypto))
                }
            } catch (error: Exception) { outcome.offer(Result.failure(error)) }
        })
        // A prompt whose activity is destroyed may never call back, so stop waiting once the requesting page is gone.
        while (true) {
            outcome.poll(1, TimeUnit.SECONDS)?.let { return it.getOrThrow() }
            if (!live()) {
                main.post { prompt?.cancelAuthentication() }
                throw LockFailure(LOCK_CANCELLED)
            }
        }
    }

    private fun requireEntropy(value: String) {
        check((value.length == 32 || value.length == 64) && value.all { it in '0'..'9' || it in 'a'..'f' })
    }
}
