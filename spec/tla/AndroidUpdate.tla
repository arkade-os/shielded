---------------------------- MODULE AndroidUpdate ----------------------------
EXTENDS Naturals, FiniteSets

(* Begin/Cancel/Retire: AndroidUpdates::reserve/cancel, DownloadOwner::drop.
   Receive/Publish: PrivacyTransport::download_update/finish_update, DownloadOwner::publish.
   Verify: check_candidate, AndroidUpdater.verify after staging.
   Tap/Hide/Prepare/Saved: createAndroidUpdateController.update/visibilityChanged, prepareAndroidInstall.
   Queue/Gone/Refuse: native_android_update_open, AndroidUpdates::prepared, AndroidUpdater.openInstaller.
   Run/Background/Timeout/LateRun: AndroidUpdateAuthorization.run around startActivity. *)

CONSTANTS WorkerCount, MaxGeneration, MaxCrashes, MaxHandoffs,
    BreakOwner, BreakTransport, BreakFence, BreakLength, BreakHash,
    BreakCertificate, BreakPackage, BreakVersion, BreakRecheck, BreakConsent,
    BreakPrepare, BreakFileLease, BreakMissingFile, BreakAuthFence

Workers == 1..WorkerCount
Phases == {"idle", "downloading", "received", "checked", "rejected", "ready", "failed"}
NetworkPhases == {"downloading", "received", "checked", "rejected"}
Bytes == {"good", "short", "hash"}
Identities == {"good", "certificate", "package", "version"}
Handoffs == {"none", "preparing", "saved", "queued"}
Faults == {"unchecked", "unconsented", "unsaved", "late"}

VARIABLES jobs, generation, mode, owner, staged, crashes, visible, bad
vars == <<jobs, generation, mode, owner, staged, crashes, visible, bad>>

Init ==
    /\ generation = 0 /\ mode = "tor" /\ owner = 0 /\ staged = 0 /\ crashes = 0
    /\ visible = TRUE /\ bad = {}
    /\ jobs = [w \in Workers |-> [phase |-> "idle", ticket |-> 0,
        throughReady |-> TRUE, bytes |-> "good", identity |-> "good",
        cancelled |-> FALSE, published |-> FALSE, publishCurrent |-> FALSE,
        file |-> FALSE, archiveValid |-> TRUE, tap |-> FALSE, fresh |-> FALSE,
        handoff |-> "none", stale |-> FALSE, handoffs |-> 0]]

Current(w) == jobs[w].ticket = generation /\ mode # "paused" /\ ~jobs[w].cancelled
BytesGood(w) == jobs[w].bytes = "good"
IdentityGood(w) == jobs[w].identity = "good"
AllowedChecks(w) ==
    /\ (jobs[w].bytes # "short" \/ BreakLength)
    /\ (jobs[w].bytes # "hash" \/ BreakHash)
    /\ (jobs[w].identity # "certificate" \/ BreakCertificate)
    /\ (jobs[w].identity # "package" \/ BreakPackage)
    /\ (jobs[w].identity # "version" \/ BreakVersion)

\* The tap that starts a download also asks for its handoff.
Begin(w) ==
    /\ jobs[w].phase = "idle" /\ staged = 0 /\ visible
    /\ (owner = 0 \/ BreakOwner) /\ (mode # "paused" \/ BreakTransport)
    /\ jobs' = [jobs EXCEPT ![w].phase = "downloading", ![w].ticket = generation,
        ![w].throughReady = (mode # "paused"), ![w].tap = TRUE, ![w].fresh = TRUE]
    /\ owner' = w
    /\ UNCHANGED <<generation, mode, staged, crashes, visible, bad>>

Receive(w, bytes, identity) ==
    /\ jobs[w].phase = "downloading"
    /\ jobs' = [jobs EXCEPT ![w].phase = "received", ![w].bytes = bytes,
        ![w].identity = identity, ![w].file = TRUE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Verify(w) ==
    /\ jobs[w].phase = "received" /\ AllowedChecks(w)
    /\ jobs' = [jobs EXCEPT ![w].phase = "checked"]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Reject(w) ==
    /\ jobs[w].phase = "received" /\ ~(BytesGood(w) /\ IdentityGood(w))
    /\ jobs' = [jobs EXCEPT ![w].phase = "rejected"]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

\* A download that completes in the background keeps its file but waits for a new tap.
Publish(w) ==
    /\ jobs[w].phase = "checked" /\ owner = w /\ staged = 0
    /\ (Current(w) \/ BreakFence)
    /\ jobs' = [jobs EXCEPT ![w].phase = "ready", ![w].published = TRUE,
        ![w].publishCurrent = Current(w), ![w].tap = @ /\ (visible \/ BreakConsent),
        ![w].fresh = visible]
    /\ owner' = 0 /\ staged' = w
    /\ UNCHANGED <<generation, mode, crashes, visible, bad>>

Cancel(w) ==
    /\ jobs[w].phase \in NetworkPhases /\ ~jobs[w].cancelled
    /\ jobs' = [jobs EXCEPT ![w].cancelled = TRUE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Retire(w) ==
    /\ jobs[w].phase \in NetworkPhases
    /\ (jobs[w].cancelled \/ jobs[w].phase = "rejected")
    /\ jobs' = [jobs EXCEPT ![w].phase = "failed", ![w].file = FALSE]
    /\ owner' = IF owner = w THEN 0 ELSE owner
    /\ UNCHANGED <<generation, mode, staged, crashes, visible, bad>>

Invalidate ==
    /\ generation < MaxGeneration /\ mode # "paused"
    /\ generation' = generation + 1 /\ mode' = "paused"
    /\ jobs' = [w \in Workers |-> IF jobs[w].phase \in NetworkPhases
        THEN [jobs[w] EXCEPT !.cancelled = TRUE] ELSE jobs[w]]
    /\ UNCHANGED <<owner, staged, crashes, visible, bad>>

Resume(nextMode) ==
    /\ mode = "paused" /\ mode' = nextMode
    /\ UNCHANGED <<jobs, generation, owner, staged, crashes, visible, bad>>

Tap(w) ==
    /\ visible /\ staged = w /\ jobs[w].phase = "ready"
    /\ jobs[w].handoff = "none" /\ ~jobs[w].tap /\ jobs[w].handoffs < MaxHandoffs
    /\ jobs' = [jobs EXCEPT ![w].tap = TRUE, ![w].fresh = TRUE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

\* A transfer in flight continues in the background; a verified update's pending handoff does not.
Hide ==
    /\ visible /\ visible' = FALSE
    /\ jobs' = [w \in Workers |-> IF jobs[w].phase # "ready" THEN jobs[w]
        ELSE [jobs[w] EXCEPT !.fresh = FALSE, !.tap = @ /\ BreakConsent,
            !.handoff = IF @ \in {"preparing", "saved"} /\ ~BreakConsent THEN "none" ELSE @]]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, bad>>

Show ==
    /\ ~visible /\ visible' = TRUE
    /\ UNCHANGED <<jobs, generation, mode, owner, staged, crashes, bad>>

Prepare(w) ==
    /\ staged = w /\ jobs[w].phase = "ready" /\ jobs[w].tap
    /\ jobs[w].handoff = "none" /\ jobs[w].handoffs < MaxHandoffs
    /\ jobs' = [jobs EXCEPT ![w].handoff = "preparing", ![w].tap = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Saved(w) ==
    /\ jobs[w].handoff = "preparing"
    /\ jobs' = [jobs EXCEPT ![w].handoff = "saved"]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

\* The host's handoff call leases the staged file until it returns.
Queue(w) ==
    /\ jobs[w].handoff = "saved" \/ (BreakPrepare /\ jobs[w].handoff = "preparing")
    /\ staged = w /\ (jobs[w].file \/ BreakMissingFile)
    /\ (jobs[w].archiveValid \/ BreakRecheck)
    /\ jobs' = [jobs EXCEPT ![w].handoff = "queued"]
    /\ bad' = bad \cup (IF jobs[w].handoff = "preparing" THEN {"unsaved"} ELSE {})
        \cup (IF ~jobs[w].archiveValid THEN {"unchecked"} ELSE {})
        \cup (IF ~jobs[w].fresh THEN {"unconsented"} ELSE {})
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible>>

Gone(w) ==
    /\ jobs[w].handoff = "saved"
    /\ staged # w \/ (~jobs[w].file /\ ~BreakMissingFile)
    /\ jobs' = [jobs EXCEPT ![w].handoff = "none",
        ![w].phase = IF staged = w THEN "failed" ELSE @]
    /\ staged' = IF staged = w THEN 0 ELSE staged
    /\ UNCHANGED <<generation, mode, owner, crashes, visible, bad>>

\* A file that fails the recheck is deleted, so the next attempt downloads again.
Refuse(w) ==
    /\ jobs[w].handoff = "saved" /\ staged = w /\ jobs[w].file
    /\ ~jobs[w].archiveValid /\ ~BreakRecheck
    /\ jobs' = [jobs EXCEPT ![w].handoff = "none", ![w].file = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Released(w) == IF staged = w THEN jobs[w].file ELSE FALSE

Run(w) ==
    /\ jobs[w].handoff = "queued" /\ visible
    /\ jobs' = [jobs EXCEPT ![w].handoff = "none", ![w].handoffs = @ + 1,
        ![w].file = Released(w)]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Background(w) ==
    /\ jobs[w].handoff = "queued" /\ ~visible
    /\ jobs' = [jobs EXCEPT ![w].handoff = "none", ![w].file = Released(w)]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Timeout(w) ==
    /\ jobs[w].handoff = "queued"
    /\ jobs' = [jobs EXCEPT ![w].handoff = "none", ![w].stale = TRUE,
        ![w].file = Released(w)]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

LateRun(w) ==
    /\ jobs[w].stale
    /\ jobs' = [jobs EXCEPT ![w].stale = FALSE]
    /\ bad' = bad \cup (IF BreakAuthFence THEN {"late"} ELSE {})
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible>>

Tamper(w) ==
    /\ jobs[w].phase = "ready" /\ jobs[w].archiveValid
    /\ jobs' = [jobs EXCEPT ![w].archiveValid = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Evict(w) ==
    /\ jobs[w].phase = "ready" /\ jobs[w].file /\ jobs[w].handoff # "queued"
    /\ jobs' = [jobs EXCEPT ![w].file = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, crashes, visible, bad>>

Discard(w) ==
    /\ staged = w /\ jobs[w].phase = "ready"
    /\ jobs' = [jobs EXCEPT ![w].phase = "failed", ![w].tap = FALSE,
        ![w].file = @ /\ jobs[w].handoff = "queued" /\ ~BreakFileLease]
    /\ staged' = 0
    /\ UNCHANGED <<generation, mode, owner, crashes, visible, bad>>

Crash ==
    /\ crashes < MaxCrashes /\ generation < MaxGeneration
    /\ crashes' = crashes + 1 /\ generation' = generation + 1 /\ mode' = "paused"
    /\ owner' = 0 /\ staged' = 0
    /\ jobs' = [w \in Workers |-> [jobs[w] EXCEPT
        !.phase = IF @ \in NetworkPhases \cup {"ready"} THEN "failed" ELSE @,
        !.file = FALSE, !.tap = FALSE, !.fresh = FALSE, !.handoff = "none", !.stale = FALSE]]
    /\ UNCHANGED <<visible, bad>>

Next ==
    \/ \E w \in Workers : Begin(w) \/ Verify(w) \/ Reject(w) \/ Publish(w)
        \/ Cancel(w) \/ Retire(w) \/ Tap(w) \/ Prepare(w) \/ Saved(w)
        \/ Queue(w) \/ Gone(w) \/ Refuse(w) \/ Run(w) \/ Background(w)
        \/ Timeout(w) \/ LateRun(w) \/ Tamper(w) \/ Evict(w) \/ Discard(w)
    \/ \E w \in Workers, bytes \in Bytes, identity \in Identities : Receive(w, bytes, identity)
    \/ \E nextMode \in {"tor", "direct"} : Resume(nextMode)
    \/ Invalidate \/ Crash \/ Hide \/ Show

TypeOK ==
    /\ generation \in 0..MaxGeneration /\ mode \in {"tor", "direct", "paused"}
    /\ owner \in Workers \cup {0} /\ staged \in Workers \cup {0}
    /\ crashes \in 0..MaxCrashes /\ visible \in BOOLEAN /\ bad \subseteq Faults
    /\ jobs \in [Workers -> [phase: Phases, ticket: 0..MaxGeneration,
        throughReady: BOOLEAN, bytes: Bytes, identity: Identities, cancelled: BOOLEAN,
        published: BOOLEAN, publishCurrent: BOOLEAN, file: BOOLEAN,
        archiveValid: BOOLEAN, tap: BOOLEAN, fresh: BOOLEAN, handoff: Handoffs,
        stale: BOOLEAN, handoffs: 0..MaxHandoffs]]

OneDownloader == Cardinality({w \in Workers : jobs[w].phase \in NetworkPhases}) <= 1
ReadyTransportOnly == \A w \in Workers : jobs[w].throughReady
FreshPublication == \A w \in Workers : jobs[w].published => jobs[w].publishCurrent
CompleteBytes == \A w \in Workers : jobs[w].published => jobs[w].bytes # "short"
MatchingHash == \A w \in Workers : jobs[w].published => jobs[w].bytes # "hash"
MatchingCertificate == \A w \in Workers : jobs[w].published => jobs[w].identity # "certificate"
MatchingPackage == \A w \in Workers : jobs[w].published => jobs[w].identity # "package"
NewerVersion == \A w \in Workers : jobs[w].published => jobs[w].identity # "version"
RecheckedHandoff == "unchecked" \notin bad
ExplicitHandoff == "unconsented" \notin bad
SavedBeforeHandoff == "unsaved" \notin bad
HandoffHasFile == \A w \in Workers : jobs[w].handoff = "queued" => jobs[w].file
NoCancelledHandoff == "late" \notin bad

Spec == Init /\ [][Next]_vars
=============================================================================
