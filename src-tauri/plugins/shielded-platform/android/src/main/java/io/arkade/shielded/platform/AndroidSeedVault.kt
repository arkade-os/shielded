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
    companion object {
        private val access = Any()
    }

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

    fun get(): String? = synchronized(access) {
        val encoded = records.getString("seed", null) ?: return@synchronized null
        check(encoded.length <= 128)
        val blob = Base64.decode(encoded, Base64.NO_WRAP)
        check(blob.size == 93 && blob[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, blob.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val plaintext = cipher.doFinal(blob, 13, blob.size - 13)
        try {
            plaintext.toString(Charsets.UTF_8).also { requireSeed(it) }
        } finally { plaintext.fill(0) }
    }

    fun set(value: String) = synchronized(access) {
        check(!Thread.currentThread().isInterrupted)
        requireSeed(value)
        val plaintext = value.toByteArray(Charsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        cipher.updateAAD(aad)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        check(cipher.iv.size == 12)
        val blob = byteArrayOf(1) + cipher.iv + encrypted
        check(!Thread.currentThread().isInterrupted)
        val previous = records.getString("seed", null)
        // SharedPreferences updates its map before the file, so a failed write puts the durable record back: get() would otherwise report a seed the disk lacks, and a plain remove would drop the seed a restore is replacing.
        if (!records.edit().putString("seed", Base64.encodeToString(blob, Base64.NO_WRAP)).commit()) {
            val restored = records.edit().apply { if (previous == null) remove("seed") else putString("seed", previous) }.commit()
            error(if (restored) "The wallet seed could not be stored." else "The wallet seed could not be stored, and its previous record could not be rewritten.")
        }
    }

    fun clear() = synchronized(access) {
        check(records.edit().clear().commit())
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    fun create(value: String) = synchronized(access) {
        requireSeed(value)
        check(!Thread.currentThread().isInterrupted)
        val previous = get()
        check(previous == null || previous == value)
        if (previous == null) set(value)
    }

    private fun requireSeed(value: String) {
        check(value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' })
    }
}
