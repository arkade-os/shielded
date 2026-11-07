package io.arkade.shielded.platform

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidSeedVault(context: Context) {
    private val records = context.getSharedPreferences("shielded_seed_v1", Context.MODE_PRIVATE)
    private val alias = "io.arkade.shielded.seed.v1"
    private val aad = alias.toByteArray(Charsets.UTF_8)

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing is SecretKey) return existing
        check(create && records.all.isEmpty())
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    @Synchronized
    fun get(): String? {
        val encoded = records.getString("seed", null) ?: return null
        check(encoded.length <= 128)
        val blob = Base64.decode(encoded, Base64.NO_WRAP)
        check(blob.size == 93 && blob[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, blob.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val plaintext = cipher.doFinal(blob, 13, blob.size - 13)
        return try {
            plaintext.toString(Charsets.UTF_8).also { requireSeed(it) }
        } finally { plaintext.fill(0) }
    }

    @Synchronized
    fun set(value: String) {
        requireSeed(value)
        val plaintext = value.toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        cipher.updateAAD(aad)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        check(cipher.iv.size == 12)
        val blob = byteArrayOf(1) + cipher.iv + encrypted
        check(records.edit().putString("seed", Base64.encodeToString(blob, Base64.NO_WRAP)).commit())
    }

    private fun requireSeed(value: String) {
        check(value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' })
    }
}
