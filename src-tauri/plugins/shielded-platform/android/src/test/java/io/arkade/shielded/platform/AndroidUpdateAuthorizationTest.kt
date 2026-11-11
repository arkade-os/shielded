package io.arkade.shielded.platform

import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class AndroidUpdateAuthorizationTest {
    private data class Outcome(val error: Throwable?, val interrupted: Boolean)
    private fun result(worker: ExecutorService, action: () -> Unit) = worker.submit<Outcome> {
        val error = try { action(); null } catch (error: Exception) { error }
        Outcome(error, Thread.currentThread().isInterrupted)
    }

    @Test fun authorizedActionsRunExactlyOnce() {
        val calls = AtomicInteger()
        AndroidUpdateAuthorization({ it.run(); true }, { true }).run { calls.incrementAndGet() }
        assertEquals(1, calls.get())
    }

    @Test fun failedOriginOrGenerationChecksPreventTheAction() {
        val calls = AtomicInteger()
        try {
            AndroidUpdateAuthorization({ it.run(); true }, { false }).run { calls.incrementAndGet() }
            fail("Expected rejection")
        } catch (_: UpdateRejected) { }
        assertEquals(0, calls.get())
    }

    @Test fun timedOutQueuedActionsCannotCommitWhenTheMainThreadReturns() {
        val worker = Executors.newSingleThreadExecutor()
        val queued = AtomicReference<Runnable>()
        val posted = CountDownLatch(1)
        val calls = AtomicInteger()
        try {
            val outcome = result(worker) {
                AndroidUpdateAuthorization({ queued.set(it); posted.countDown(); true }, { true }, 20)
                    .run { calls.incrementAndGet() }
            }
            assertTrue(posted.await(5, TimeUnit.SECONDS))
            assertTrue(outcome.get(5, TimeUnit.SECONDS).error is UpdateRejected)
            queued.get().run()
            assertEquals(0, calls.get())
        } finally { worker.shutdownNow() }
    }

    @Test fun interruptedQueuedActionsCannotCommitLater() {
        val worker = Executors.newSingleThreadExecutor()
        val thread = AtomicReference<Thread>()
        val queued = AtomicReference<Runnable>()
        val posted = CountDownLatch(1)
        val calls = AtomicInteger()
        try {
            val outcome = result(worker) {
                thread.set(Thread.currentThread())
                AndroidUpdateAuthorization({ queued.set(it); posted.countDown(); true }, { true }, 5_000)
                    .run { calls.incrementAndGet() }
            }
            assertTrue(posted.await(5, TimeUnit.SECONDS))
            thread.get().interrupt()
            val response = outcome.get(5, TimeUnit.SECONDS)
            assertTrue(response.error is UpdateRejected)
            assertTrue(response.interrupted)
            queued.get().run()
            assertEquals(0, calls.get())
        } finally { worker.shutdownNow() }
    }

    @Test fun timedOutRunningActionsRemainAmbiguousInsteadOfAbandoningTheirSession() {
        val worker = Executors.newSingleThreadExecutor()
        val main = Executors.newSingleThreadExecutor()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val calls = AtomicInteger()
        try {
            val outcome = result(worker) {
                AndroidUpdateAuthorization({ task ->
                    main.execute(task)
                    assertTrue(entered.await(5, TimeUnit.SECONDS))
                    true
                }, { true }, 20).run {
                    entered.countDown()
                    release.await()
                    calls.incrementAndGet()
                    finished.countDown()
                }
            }
            assertTrue(outcome.get(5, TimeUnit.SECONDS).error is AmbiguousUpdateAuthorization)
            release.countDown()
            assertTrue(finished.await(5, TimeUnit.SECONDS))
            assertEquals(1, calls.get())
        } finally { release.countDown(); worker.shutdownNow(); main.shutdownNow() }
    }

    @Test fun interruptedRunningActionsRemainAmbiguous() {
        val worker = Executors.newSingleThreadExecutor()
        val main = Executors.newSingleThreadExecutor()
        val thread = AtomicReference<Thread>()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            val outcome = result(worker) {
                thread.set(Thread.currentThread())
                AndroidUpdateAuthorization({ task -> main.execute(task); true }, { true }, 5_000)
                    .run { entered.countDown(); release.await() }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            thread.get().interrupt()
            val response = outcome.get(5, TimeUnit.SECONDS)
            assertTrue(response.error is AmbiguousUpdateAuthorization)
            assertTrue(response.interrupted)
        } finally { release.countDown(); worker.shutdownNow(); main.shutdownNow() }
    }

    @Test fun mainThreadActionsRecheckTheirDeadlineBeforeRunning() {
        val clock = AtomicLong()
        val calls = AtomicInteger()
        try {
            AndroidUpdateAuthorization({ clock.set(1_000_000_001); it.run(); true }, { true }, 1_000, clock::get)
                .run { calls.incrementAndGet() }
            fail("Expected rejection")
        } catch (_: UpdateRejected) { }
        assertEquals(0, calls.get())
    }

    @Test fun rejectedPostsCannotLeaveAnExecutableTaskBehind() {
        val queued = AtomicReference<Runnable>()
        val calls = AtomicInteger()
        try {
            AndroidUpdateAuthorization({ queued.set(it); false }, { true }).run { calls.incrementAndGet() }
            fail("Expected rejection")
        } catch (_: UpdateRejected) { }
        queued.get().run()
        assertEquals(0, calls.get())
    }

    @Test fun runningAuthorizationIsNotMisclassifiedAsAKnownPrecommitFailure() {
        assertTrue(AndroidUpdatePolicy.mayHaveCommitted(false, AmbiguousUpdateAuthorization()))
        assertTrue(AndroidUpdatePolicy.mayHaveCommitted(true, UpdateRejected("Installer result unavailable")))
        assertFalse(AndroidUpdatePolicy.mayHaveCommitted(false, UpdateRejected("Authorization expired before running")))
    }
}
