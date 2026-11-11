package io.arkade.shielded.platform

import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicReference

internal class AmbiguousUpdateAuthorization : Exception("Android may still be handling this update. Check its status before retrying.")

internal class AndroidUpdateAuthorization(
    private val post: (Runnable) -> Boolean,
    private val allowed: () -> Boolean,
    private val timeoutMillis: Long = 15_000,
    private val now: () -> Long = System::nanoTime,
) {
    private enum class Phase { QUEUED, RUNNING, FINISHED, CANCELLED }
    init { require(timeoutMillis in 1L..15_000L) }

    fun run(action: () -> Unit) {
        val phase = AtomicReference(Phase.QUEUED)
        val deadline = now() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        val task = FutureTask<Unit> {
            if (!phase.compareAndSet(Phase.QUEUED, Phase.RUNNING)) throw UpdateRejected("Android update authorization expired")
            try {
                if (!allowed() || now() - deadline >= 0) throw UpdateRejected("Return to Shielded to continue the Android update")
                action()
            } finally { phase.set(Phase.FINISHED) }
        }
        val accepted = try { post(task) } catch (_: Exception) { cancel(task, phase) }
        if (!accepted) cancel(task, phase)
        try {
            task.get((deadline - now()).coerceAtLeast(1), TimeUnit.NANOSECONDS)
        } catch (_: TimeoutException) {
            cancel(task, phase)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            cancel(task, phase)
        } catch (error: ExecutionException) {
            throw (error.cause as? Exception ?: error)
        }
    }

    private fun cancel(task: FutureTask<Unit>, phase: AtomicReference<Phase>): Nothing {
        val queued = phase.compareAndSet(Phase.QUEUED, Phase.CANCELLED)
        task.cancel(false)
        if (queued) throw UpdateRejected("Android could not authorize this update. Return to Shielded and try again.")
        // Cancellation cannot stop an action that already started.
        throw AmbiguousUpdateAuthorization()
    }
}
