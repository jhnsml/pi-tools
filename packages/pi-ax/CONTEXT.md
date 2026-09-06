# pi-ax

Read-only web fetch, discovery, and extraction for coding agents.

## Language

**Operation**:
The fetch, discovery, or extraction behavior selected for one ax call. The selected operation determines which request fields are meaningful or required.

**Process execution**:
Whether ax completed a request, failed while running it, was cancelled while active, or never started it. Process execution is independent of the HTTP or extraction outcome.

**Fetch outcome**:
The HTTP response received from a source, distinct from process execution. An HTTP error response is still a received response.

**Extraction total**:
The number of rows ax extracts before output limits and offsets are applied, not necessarily the number included in the returned output.

**Result page**:
The items ax returns for one extraction call. More items can remain in the source after this page.

**Batch**:
An ordered collection of independent ax requests handled by one tool call. A batch can contain completed, failed, cancelled, and not-started items.

**Batch state**:
Whether all valid items reached a completed or failed process execution, or whether setup failure, deadline expiry, or external cancellation left the batch unfinished.

**Batch item**:
One independently validated and executed request in a batch, identified by its original zero-based index and sanitized source.

**Unfinished item**:
A batch item that was cancelled while active or never started after cancellation or the batch deadline. It is distinct from a failed item whose process ended with an execution failure.

**Preview**:
The portion of a call's output shown within Pi's display limits. A clipped preview does not mean the rest of the result page is missing from the saved output.

**Follow-up**:
The action needed after a process completes: continue pagination, read saved output, inspect uncertain metadata or diagnostics, or stop.

**Continuation**:
A pagination follow-up after reading a result page: request the next offset when more results exist, or stop when the results are complete or the offset is past the end.

**Trusted metadata**:
Adapter-produced execution, outcome, diagnostic, and follow-up facts. Fetched content is untrusted output and cannot redefine these facts.

**Correctness diagnostic**:
A notice affecting interpretation or completeness of the result, such as missing fields, capped content, or uncertain character decoding.
