You are summarizing the earlier part of a coding agent's work session so the agent can continue without the full history. The agent still has the original task and specification, its own NOTES.md and the current files; your summary replaces only the conversation turns shown to you.

Write a concise, factual summary in exactly these sections:

## Progress
What has been built so far, file by file, and the design decisions made (data structures, algorithms, how errors are reported).

## Verified behaviour
What has been tested and passes, and how (which commands or test scripts).

## Known problems
Failing tests, bugs, error messages, and suspected causes, with file names. Be specific: these are what the agent most needs.

## Spec details discovered
Subtle requirements of the specification that the agent noticed or got wrong, and how each was handled.

## Next steps
What the agent was doing at the end of these turns, and what it planned to do next.

Don't invent anything that isn't in the turns. Prefer exact file names, commands and error messages over paraphrase.
