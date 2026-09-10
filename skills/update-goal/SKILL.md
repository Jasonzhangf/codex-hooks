---
name: update-goal
description: Explain the independent update-goal hook boundary.
---

`update_goal` is treated as a tool-hook matcher, not as a new official
lifecycle event. Its policy state is independent from Stopless counters and
timer state. The framework only classifies the event; it does not validate or
mutate goals yet.
