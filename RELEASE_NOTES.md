# Branchlight 0.1.2

Show how many commits the current checkout is behind its tracking upstream, beside Pull in the main toolbar. When local commits are ahead, show that count too.

- Counts remain visible in Graph, Changes, and Files and apply to the current checkout even while soloing another branch.
- Hover to see the tracking branch and the comparison details. Counts use the last fetched remote state; Pull or fetch in another Git tool to update remote refs.
- Branches without an upstream or with unavailable tracking refs show an explicit status instead of a false zero. Detached HEAD hides the comparison.

Requires Git for Windows on PATH. Download Branchlight.exe; a separate Node.js installation is not required. The portable app is unsigned, and SHA256SUMS.txt contains its checksum.
