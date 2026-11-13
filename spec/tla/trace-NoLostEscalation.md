VIOLATED NoMissedEvent, 6 states

| # | action | changed |
|---|---|---|
| 1 | Initial | state = (s1 :> "live" @@ s2 :> "live")<br>faults = 0<br>missed = (s1 :> FALSE @@ s2 :> FALSE)<br>attempts = (s1 :> 0 @@ s2 :> 0)<br>torn = 0<br>baseline = (s1 :> TRUE @@ s2 :> TRUE)<br>events = 0<br>stale = (s1 :> FALSE @@ s2 :> FALSE)<br>escalated = FALSE<br>lost = (s1 :> FALSE @@ s2 :> FALSE)<br>reading = (s1 :> FALSE @@ s2 :> FALSE)<br>snapSpent = (s1 :> FALSE @@ s2 :> FALSE) |
| 2 | Fail | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 1 |
| 3 | Backoff | state = (s1 :> "backoff" @@ s2 :> "live")<br>attempts = (s1 :> 1 @@ s2 :> 0) |
| 4 | Event | missed = (s1 :> TRUE @@ s2 :> FALSE)<br>events = 1<br>lost = (s1 :> TRUE @@ s2 :> FALSE) |
| 5 | Reopen | state = (s1 :> "reopened" @@ s2 :> "live") |
| 6 | CatchUpRead | state = (s1 :> "live" @@ s2 :> "live")<br>missed = (s1 :> FALSE @@ s2 :> FALSE) |
