# Two years out: the decision layer becomes the licensing surface for AI

**290 words.**

Today every agent framework treats permission as a boolean at the tool boundary. Can this agent call
this API — yes or no. The check is a scope string, evaluated once, with no memory of what it
permitted and no opinion about whether now is a good time.

That boundary is about to move, for an unglamorous reason: it is where liability lands. When an agent
issues a refund that should not have been issued, "the model decided" is not a defence anyone will
accept, and neither is an access log that records only that the call was allowed. The question stops
being *could it* and becomes *at what confidence, under whose authority, with what rollback, and how
stale was the evidence*. Those are five different fields, and none of them fit in a scope string.

So the layer gets extracted. Not because it is elegant, but because the same way authentication left
individual applications once every application needed it and none wanted to own the consequences of
getting it wrong, decision policy will leave individual agents once every agent needs it and none
wants to be the one that approved the payout. Expect it to arrive first in the domains that already
have a compliance function to hand it to — payments, healthcare, infrastructure change control — and
to look, at first, like a boring piece of middleware.

The consequence is the interesting part. Whoever owns the decision layer owns the audit log. Whoever
owns the audit log owns the only artefact an insurer can price, and insurance is how autonomy gets
sold to anyone with a board. The decision layer will not be the most technically impressive part of
the AI stack. It will be the part with the contracts attached.
