# Clean Linux recipient verification

This tests shared bundle adoption and runtime behavior on Ubuntu 24.04 x64.
The native database requires glibc 2.38 and GLIBCXX_3.4.32 or newer; Debian 12
is too old. It does not
validate Mac binaries, `Flow.app`, Gatekeeper, or the public Mac bootstrap; use a
clean macOS VM for those.

Prepare `source.tar` from the exact candidate commit (`git archive`) in a temporary
Docker build context. Copy `Dockerfile.builder` there as `Dockerfile`, then build
with `docker build --platform linux/amd64 -t flow-bundle-builder .`. Run that image
with a writable `/output` mount and the candidate version argument to produce
the Linux archive/checksum (the default `0.0.0` is for local tests only). The image
contains the compiler; the recipient image does not.

Build `Dockerfile.recipient` for `linux/amd64` and run it with the output directory
mounted read-only at `/downloads`. Copy `verify-recipient.sh` into the container
and run it as the `flow` user. It asserts that developer prerequisites are absent,
checks the archive checksum, adopts the bundle with its own Node runtime, tests
Git/native components, and launches the browser server with isolated empty data.
The script disables live-feed updates so a published release cannot change the
candidate under test. Verify update handoff separately using two candidate bundles.

The recipient base includes OS libraries, certificates, curl and SSH. Node, npm,
Git and build tools are supplied by the bundle or absent. Installing provider CLIs
and logging in should be exercised through onboarding with separate test data.
Keep the container available for browser verification; stop the managed app and
remove only the named test containers when the test loop is complete.
