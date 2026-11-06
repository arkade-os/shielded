VIOLATED UnknownNeverRequeued, 7 states

| # | action | changed |
|---|---|---|
| 1 | Initial | phase = "locked"<br>observations = 0<br>badJournal = FALSE<br>requestGeneration = (w1 :> 0 @@ w2 :> 0)<br>timeouts = 0<br>badDelivery = FALSE<br>journal = "empty"<br>pc = (w1 :> "idle" @@ w2 :> "idle")<br>badDispatch = FALSE<br>kind = (w1 :> "none" @@ w2 :> "none")<br>reserved = FALSE<br>generation = 0<br>inFlight = 0<br>evidence = (w1 :> FALSE @@ w2 :> FALSE)<br>observedPrepared = (w1 :> FALSE @@ w2 :> FALSE)<br>sends = 0<br>requeued = FALSE<br>effects = 0 |
| 2 | Unlock | phase = "bootstrapping"<br>generation = 1 |
| 3 | Bootstrap | phase = "ready" |
| 4 | Prepare | journal = "prepared"<br>reserved = TRUE |
| 5 | Capture | requestGeneration = (w1 :> 1 @@ w2 :> 0)<br>pc = (w1 :> "captured" @@ w2 :> "idle")<br>kind = (w1 :> "mutation" @@ w2 :> "none")<br>observedPrepared = (w1 :> TRUE @@ w2 :> FALSE) |
| 6 | ClaimMutation | journal = "unknown"<br>pc = (w1 :> "claimed" @@ w2 :> "idle") |
| 7 | TimeoutUnknown | timeouts = 1<br>journal = "prepared"<br>requeued = TRUE |
