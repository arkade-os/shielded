package io.arkade.shielded.platform

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class AndroidUpdateDispatchTest {
    @Test fun anInstallRejectedBeforeDispatchHasAKnownFailureReceipt() {
        val dispatch = AndroidUpdateDispatch(true)
        assertEquals(UpdateDispatchFailure.INSTALL_FAILED, dispatch.fail())
        assertFalse(dispatch.begin())
    }

    @Test fun aStartedInstallKeepsAmbiguousFailureSemantics() {
        val dispatch = AndroidUpdateDispatch(true)
        assertTrue(dispatch.begin())
        assertEquals(UpdateDispatchFailure.REJECTED, dispatch.fail())
    }

    @Test fun confirmAndReadonlyCommandsNeverReturnInstallFailureReceipts() {
        val dispatch = AndroidUpdateDispatch(false)
        assertEquals(UpdateDispatchFailure.REJECTED, dispatch.fail())
        assertFalse(dispatch.begin())
    }

    @Test fun aCancelledQueuedWorkerCannotDispatchLater() {
        val dispatch = AndroidUpdateDispatch(true)
        val calls = AtomicInteger()
        val queued = Runnable { if (dispatch.begin()) calls.incrementAndGet() }
        assertEquals(UpdateDispatchFailure.INSTALL_FAILED, dispatch.fail())
        queued.run()
        assertEquals(0, calls.get())
    }

    @Test fun failuresAndLateResponsesCanOnlyReplyOnce() {
        val dispatch = AndroidUpdateDispatch(true)
        assertEquals(UpdateDispatchFailure.INSTALL_FAILED, dispatch.fail())
        assertNull(dispatch.fail())
        assertFalse(dispatch.complete())
    }

    @Test fun aCompletedOperationCannotBeOverwrittenByALateRejection() {
        val dispatch = AndroidUpdateDispatch(true)
        assertFalse(dispatch.complete())
        assertTrue(dispatch.begin())
        assertTrue(dispatch.complete())
        assertFalse(dispatch.complete())
        assertNull(dispatch.fail())
        assertFalse(dispatch.begin())
    }
}
