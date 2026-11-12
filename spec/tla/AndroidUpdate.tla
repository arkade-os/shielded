---------------------------- MODULE AndroidUpdate ----------------------------
EXTENDS Naturals, FiniteSets

(* Begin/Cancel/Retire: AndroidUpdates::reserve/cancel, DownloadOwner::drop.
   Receive/Publish: PrivacyTransport::download_update/finish_update, DownloadOwner::publish.
   Verify/BeginInstall: check_candidate, AndroidUpdater.verify, AndroidUpdates::begin_install.
   Click/PermissionReturn: createAndroidUpdateController.install/permission/visibilityChanged.
   Submit/Reply/Reconcile: AndroidUpdater.install/receive/reconcile; InstallOwner::finish. *)

CONSTANTS WorkerCount, MaxGeneration, MaxCrashes,
    BreakOwner, BreakTransport, BreakFence, BreakLength, BreakHash,
    BreakCertificate, BreakPackage, BreakVersion, BreakRecheck,
    BreakConsent, BreakFileLease, BreakCommitOnce, BreakPending

Workers == 1..WorkerCount
Phases == {"idle", "downloading", "received", "checked", "rejected", "ready",
    "permission", "installing", "submitted", "user", "unknown", "done", "failed"}
NetworkPhases == {"downloading", "received", "checked", "rejected"}
Bytes == {"good", "short", "hash"}
Identities == {"good", "certificate", "package", "version"}
OSStates == {"none", "pending", "success", "failure"}

VARIABLES jobs, generation, mode, owner, staged, permission, crashes
vars == <<jobs, generation, mode, owner, staged, permission, crashes>>

Init ==
    /\ generation = 0 /\ mode = "tor" /\ owner = 0 /\ staged = 0
    /\ permission = FALSE /\ crashes = 0
    /\ jobs = [w \in Workers |-> [phase |-> "idle", ticket |-> 0,
        throughReady |-> TRUE, bytes |-> "good", identity |-> "good",
        cancelled |-> FALSE, published |-> FALSE, publishCurrent |-> FALSE,
        file |-> FALSE, archiveValid |-> TRUE, click |-> FALSE,
        afterSettings |-> FALSE, rechecked |-> FALSE, installConsent |-> FALSE,
        commits |-> 0, os |-> "none", approved |-> FALSE]]

Current(w) == jobs[w].ticket = generation /\ mode # "paused" /\ ~jobs[w].cancelled
BytesGood(w) == jobs[w].bytes = "good"
IdentityGood(w) == jobs[w].identity = "good"
AllowedChecks(w) ==
    /\ (jobs[w].bytes # "short" \/ BreakLength)
    /\ (jobs[w].bytes # "hash" \/ BreakHash)
    /\ (jobs[w].identity # "certificate" \/ BreakCertificate)
    /\ (jobs[w].identity # "package" \/ BreakPackage)
    /\ (jobs[w].identity # "version" \/ BreakVersion)

Begin(w) ==
    /\ jobs[w].phase = "idle" /\ staged = 0
    /\ (owner = 0 \/ BreakOwner) /\ (mode # "paused" \/ BreakTransport)
    /\ jobs' = [jobs EXCEPT ![w].phase = "downloading",
        ![w].ticket = generation, ![w].throughReady = (mode # "paused")]
    /\ owner' = w
    /\ UNCHANGED <<generation, mode, staged, permission, crashes>>

Receive(w, bytes, identity) ==
    /\ jobs[w].phase = "downloading"
    /\ jobs' = [jobs EXCEPT ![w].phase = "received", ![w].bytes = bytes,
        ![w].identity = identity, ![w].file = TRUE]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Verify(w) ==
    /\ jobs[w].phase = "received" /\ AllowedChecks(w)
    /\ jobs' = [jobs EXCEPT ![w].phase = "checked"]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Reject(w) ==
    /\ jobs[w].phase = "received" /\ ~(BytesGood(w) /\ IdentityGood(w))
    /\ jobs' = [jobs EXCEPT ![w].phase = "rejected"]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Publish(w) ==
    /\ jobs[w].phase = "checked" /\ owner = w /\ staged = 0
    /\ (Current(w) \/ BreakFence)
    /\ jobs' = [jobs EXCEPT ![w].phase = "ready", ![w].published = TRUE,
        ![w].publishCurrent = Current(w)]
    /\ owner' = 0 /\ staged' = w
    /\ UNCHANGED <<generation, mode, permission, crashes>>

Cancel(w) ==
    /\ jobs[w].phase \in NetworkPhases /\ ~jobs[w].cancelled
    /\ jobs' = [jobs EXCEPT ![w].cancelled = TRUE]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Retire(w) ==
    /\ jobs[w].phase \in NetworkPhases
    /\ (jobs[w].cancelled \/ jobs[w].phase = "rejected")
    /\ jobs' = [jobs EXCEPT ![w].phase = "failed", ![w].file = FALSE]
    /\ owner' = IF owner = w THEN 0 ELSE owner
    /\ UNCHANGED <<generation, mode, staged, permission, crashes>>

Invalidate ==
    /\ generation < MaxGeneration /\ mode # "paused"
    /\ generation' = generation + 1 /\ mode' = "paused"
    /\ jobs' = [w \in Workers |-> IF jobs[w].phase \in NetworkPhases
        THEN [jobs[w] EXCEPT !.cancelled = TRUE] ELSE jobs[w]]
    /\ UNCHANGED <<owner, staged, permission, crashes>>

Resume(nextMode) ==
    /\ mode = "paused" /\ mode' = nextMode
    /\ UNCHANGED <<jobs, generation, owner, staged, permission, crashes>>

Click(w) ==
    /\ staged = w /\ jobs[w].phase = "ready"
    /\ (~jobs[w].click \/ jobs[w].afterSettings)
    /\ jobs' = [jobs EXCEPT ![w].click = TRUE, ![w].afterSettings = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

NeedPermission(w) ==
    /\ staged = w /\ jobs[w].phase = "ready" /\ jobs[w].click /\ ~permission
    /\ jobs' = [jobs EXCEPT ![w].phase = "permission"]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

PermissionReturn(w) ==
    /\ jobs[w].phase = "permission"
    /\ jobs' = [jobs EXCEPT ![w].phase = "ready", ![w].click = BreakConsent,
        ![w].afterSettings = TRUE]
    /\ permission' = TRUE
    /\ UNCHANGED <<generation, mode, owner, staged, crashes>>

Tamper(w) ==
    /\ jobs[w].phase = "ready" /\ jobs[w].archiveValid
    /\ jobs' = [jobs EXCEPT ![w].archiveValid = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

BeginInstall(w) ==
    /\ staged = w /\ jobs[w].phase = "ready" /\ permission
    /\ (jobs[w].click \/ BreakConsent)
    /\ (jobs[w].archiveValid \/ BreakRecheck)
    /\ jobs' = [jobs EXCEPT ![w].phase = "installing",
        ![w].rechecked = jobs[w].archiveValid,
        ![w].installConsent = (jobs[w].click /\ ~jobs[w].afterSettings),
        ![w].click = FALSE]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Discard(w) ==
    /\ staged = w
    /\ (jobs[w].phase \in {"ready", "permission"}
        \/ (BreakFileLease /\ jobs[w].phase = "installing"))
    /\ jobs' = [jobs EXCEPT ![w].file = FALSE,
        ![w].phase = IF @ = "installing" THEN @ ELSE "failed"]
    /\ staged' = 0
    /\ UNCHANGED <<generation, mode, owner, permission, crashes>>

Submit(w) ==
    /\ (jobs[w].phase = "installing"
        \/ (BreakCommitOnce /\ jobs[w].phase = "submitted"))
    /\ jobs[w].commits < 2
    /\ jobs' = [jobs EXCEPT ![w].phase = "submitted", ![w].commits = @ + 1]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Reply(w, status) ==
    /\ jobs[w].phase = "submitted"
    /\ jobs' = [jobs EXCEPT ![w].os = status,
        ![w].phase = IF status = "pending" THEN IF BreakPending THEN "done" ELSE "user"
            ELSE IF status = "success" THEN "done" ELSE "failed"]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

UserDecision(w, approve) ==
    /\ jobs[w].phase = "user"
    /\ jobs' = [jobs EXCEPT ![w].phase = IF approve THEN "done" ELSE "failed",
        ![w].approved = approve]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

LoseCallback(w) ==
    /\ jobs[w].phase \in {"submitted", "user"}
    /\ jobs' = [jobs EXCEPT ![w].phase = "unknown"]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Reconcile(w, status) ==
    /\ jobs[w].phase = "unknown"
    /\ jobs' = [jobs EXCEPT ![w].os = status,
        ![w].phase = IF status = "pending" THEN "user"
            ELSE IF status = "success" THEN "done" ELSE "failed"]
    /\ UNCHANGED <<generation, mode, owner, staged, permission, crashes>>

Finish(w) ==
    /\ staged = w /\ jobs[w].phase \in {"done", "failed"}
    /\ jobs' = [jobs EXCEPT ![w].file = FALSE]
    /\ staged' = 0
    /\ UNCHANGED <<generation, mode, owner, permission, crashes>>

Crash ==
    /\ crashes < MaxCrashes /\ generation < MaxGeneration
    /\ crashes' = crashes + 1 /\ generation' = generation + 1 /\ mode' = "paused"
    /\ owner' = 0
    /\ staged' = IF staged # 0 /\ jobs[staged].phase \in {"submitted", "user", "unknown"}
        THEN staged ELSE 0
    /\ jobs' = [w \in Workers |-> [jobs[w] EXCEPT
        !.phase = IF @ \in NetworkPhases \cup {"ready", "permission", "installing"}
            THEN "failed" ELSE IF @ \in {"submitted", "user"} THEN "unknown" ELSE @,
        !.file = FALSE, !.click = FALSE]]
    /\ UNCHANGED permission

Next ==
    \/ \E w \in Workers : Begin(w) \/ Verify(w) \/ Reject(w) \/ Publish(w)
        \/ Cancel(w) \/ Retire(w) \/ Click(w) \/ NeedPermission(w)
        \/ PermissionReturn(w) \/ Tamper(w) \/ BeginInstall(w) \/ Discard(w)
        \/ Submit(w) \/ LoseCallback(w) \/ Finish(w)
    \/ \E w \in Workers, bytes \in Bytes, identity \in Identities : Receive(w, bytes, identity)
    \/ \E w \in Workers, status \in OSStates \ {"none"} : Reply(w, status) \/ Reconcile(w, status)
    \/ \E w \in Workers, approve \in BOOLEAN : UserDecision(w, approve)
    \/ \E nextMode \in {"tor", "direct"} : Resume(nextMode)
    \/ Invalidate \/ Crash

TypeOK ==
    /\ generation \in 0..MaxGeneration /\ mode \in {"tor", "direct", "paused"}
    /\ owner \in Workers \cup {0} /\ staged \in Workers \cup {0}
    /\ permission \in BOOLEAN /\ crashes \in 0..MaxCrashes
    /\ jobs \in [Workers -> [phase: Phases, ticket: 0..MaxGeneration,
        throughReady: BOOLEAN, bytes: Bytes, identity: Identities, cancelled: BOOLEAN,
        published: BOOLEAN, publishCurrent: BOOLEAN, file: BOOLEAN,
        archiveValid: BOOLEAN, click: BOOLEAN, afterSettings: BOOLEAN,
        rechecked: BOOLEAN, installConsent: BOOLEAN, commits: 0..2,
        os: OSStates, approved: BOOLEAN]]

OneDownloader == Cardinality({w \in Workers : jobs[w].phase \in NetworkPhases}) <= 1
ReadyTransportOnly == \A w \in Workers : jobs[w].throughReady
FreshPublication == \A w \in Workers : jobs[w].published => jobs[w].publishCurrent
CompleteBytes == \A w \in Workers : jobs[w].published => jobs[w].bytes # "short"
MatchingHash == \A w \in Workers : jobs[w].published => jobs[w].bytes # "hash"
MatchingCertificate == \A w \in Workers : jobs[w].published => jobs[w].identity # "certificate"
MatchingPackage == \A w \in Workers : jobs[w].published => jobs[w].identity # "package"
NewerVersion == \A w \in Workers : jobs[w].published => jobs[w].identity # "version"
RecheckedInstall == \A w \in Workers :
    (jobs[w].phase = "installing" \/ jobs[w].commits > 0) => jobs[w].rechecked
ExplicitInstall == \A w \in Workers :
    (jobs[w].phase = "installing" \/ jobs[w].commits > 0) => jobs[w].installConsent
PreparedFileLeased == \A w \in Workers : jobs[w].phase = "installing" => jobs[w].file
OneInstallerCommit == \A w \in Workers : jobs[w].commits <= 1
PendingRequiresUser == \A w \in Workers :
    (jobs[w].phase = "done" /\ jobs[w].os = "pending") => jobs[w].approved

Spec == Init /\ [][Next]_vars
=============================================================================
