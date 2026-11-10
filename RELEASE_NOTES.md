# Branchlight 0.1.1

Fix the split diff layout: narrow line-number gutters and equally sized code panes now stay correct when a hunk or metadata header appears first. Code uses the available width instead of being squeezed into a quarter of the preview.

Verified in Changes and commit diffs, including long lines, window resizing, and untracked files. The diff-layout regression check is included in the Windows desktop checks, and package verification now checks the bundled stylesheet as well.

Requires Git for Windows on PATH. Download Branchlight.exe; a separate Node.js installation is not required. The portable app is unsigned, and SHA256SUMS.txt contains its checksum.
