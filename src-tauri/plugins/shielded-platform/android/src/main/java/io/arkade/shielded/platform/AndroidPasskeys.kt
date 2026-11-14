package io.arkade.shielded.platform

import android.app.Activity
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import java.util.concurrent.Executor

internal const val PASSKEY_CANCELLED = "Passkey cancelled"
internal const val PASSKEY_UNAVAILABLE = "Passkey unavailable"

internal typealias PasskeyReply = (String?, Exception?) -> Unit

// A browser gives the SDK a provider's NotAllowedError unchanged, and the SDK reads it as a cancel.
internal fun passkeyCancelled(error: Exception?) =
    error is CreateCredentialCancellationException || error is GetCredentialCancellationException ||
        (error as? CreatePublicKeyCredentialDomException)?.domError is NotAllowedError ||
        (error as? GetPublicKeyCredentialDomException)?.domError is NotAllowedError

internal fun createPasskey(activity: Activity, request: String, executor: Executor, reply: PasskeyReply) =
    CredentialManager.create(activity).createCredentialAsync(
        activity, CreatePublicKeyCredentialRequest(request), null, executor,
        object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
            override fun onResult(result: CreateCredentialResponse) =
                reply((result as? CreatePublicKeyCredentialResponse)?.registrationResponseJson, null)
            override fun onError(e: CreateCredentialException) = reply(null, e)
        }
    )

internal fun getPasskey(activity: Activity, request: String, executor: Executor, reply: PasskeyReply) =
    CredentialManager.create(activity).getCredentialAsync(
        activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(request))), null, executor,
        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
            override fun onResult(result: GetCredentialResponse) =
                reply((result.credential as? PublicKeyCredential)?.authenticationResponseJson, null)
            override fun onError(e: GetCredentialException) = reply(null, e)
        }
    )
