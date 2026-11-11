package io.arkade.shielded.platform

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal enum class UpdateDispatchFailure { INSTALL_FAILED, REJECTED }

internal class AndroidUpdateDispatch(private val install: Boolean) {
    private enum class Phase { QUEUED, STARTED, CANCELLED }
    private val phase = AtomicReference(Phase.QUEUED)
    private val replied = AtomicBoolean(false)

    fun begin() = phase.compareAndSet(Phase.QUEUED, Phase.STARTED)

    fun fail(): UpdateDispatchFailure? {
        phase.compareAndSet(Phase.QUEUED, Phase.CANCELLED)
        if (!replied.compareAndSet(false, true)) return null
        return if (install && phase.get() == Phase.CANCELLED) UpdateDispatchFailure.INSTALL_FAILED else UpdateDispatchFailure.REJECTED
    }

    fun complete() = phase.get() == Phase.STARTED && replied.compareAndSet(false, true)
}
