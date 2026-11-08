# Automatic Docker image publishing

The workflow in [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml) builds the existing Dockerfile on an x86 GitHub-hosted runner and publishes **linux/amd64 only** to GitHub Container Registry (GHCR). No Docker Hub account or registry password is needed for publishing.

## 1. Enable publishing

1. Push this project, including `.github/workflows/docker-publish.yml`, to a GitHub repository.
2. In **Settings → Actions → General**, enable GitHub Actions. If your organization restricts actions, allow `actions/checkout` and Docker's `setup-buildx-action`, `metadata-action`, `login-action`, and `build-push-action`.
3. The workflow requests `contents: read` and `packages: write` for its image job. Ensure organization/repository policies permit that permission. It uses the automatically supplied, short-lived `GITHUB_TOKEN`; **do not create a repository PAT secret** for publishing.
4. Push to `main`, or open **Actions → Build and publish container → Run workflow** and choose the repository's default branch.

The push and pull-request branch filters currently name `main`. If your default branch has another name, change both filters in the workflow. Manual runs on non-default branches are skipped intentionally.

The image name is derived from the repository, with lowercase registry naming:

```text
ghcr.io/<owner>/<repository>
```

For example, repository `alice/homelab-ipam` publishes `ghcr.io/alice/homelab-ipam`. You do not need to edit the workflow's image name.

## 2. Triggers and tags

| Event | Result |
| --- | --- |
| Push to `main` (the default branch) | Publish `main`, `latest`, and `sha-<full-commit-sha>` |
| Push a tag matching `v*`, such as `v0.1.0` | Publish that exact tag and `sha-<full-commit-sha>`; leave `latest` unchanged |
| Pull request targeting `main` | Build only; no registry login or push, including fork PRs |
| Manual run on the default branch | Publish default-branch, `latest`, and commit-SHA tags |

If `main` is not the repository's default branch, its push still publishes a branch/SHA tag but not `latest`. Keep the filters aligned with your default branch.

To publish a version after committing the desired source:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Version tags are published as written (`v0.1.0`, not `0.1.0`). The workflow does not create GitHub Releases, deploy to Kubernetes, or run application tests; it builds the production application through the Dockerfile. Buildx uses GitHub Actions layer caching. QEMU is unnecessary because the runner and target are both amd64.

In the successful run, open the build step's summary for the image digest and tags. The package also appears in the repository/account's **Packages** view. Build provenance may add an attestation entry labeled `unknown/unknown` to the registry index; the runnable image remains `linux/amd64`.

## 3. Configure package visibility and access

GHCR packages are generally private on first publication, even for public source repositories. Check the package's settings explicitly:

- **Public package:** set package visibility to public if desired. Kubernetes can then pull anonymously. Never publish secrets in the image.
- **Private package:** keep it private and supply Kubernetes pull credentials as described below.
- **Existing package / permission denied:** under the package's **Manage Actions access**, grant this repository write access. Confirm repository linkage and any organization package-creation restrictions. The workflow's source label links new images to their repository.

GitHub's [container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) explains visibility, package access, and token requirements. Repository workflow permissions cannot override organization policy.

## 4. Use the image in Kubernetes

The cluster needs an amd64 worker. The example Deployment selects `kubernetes.io/arch: amd64`; an ARM-only cluster cannot run this image natively.

Prefer a build digest or a unique commit tag over `latest`. Digests are immutable; named tags can be overwritten by later publications. Replace the example `image` in [`deploy/deployment.yaml`](../deploy/deployment.yaml) with the value from the build summary, for example:

```yaml
image: ghcr.io/alice/homelab-ipam@sha256:<digest-from-build-summary>
```

Alternatively, use `ghcr.io/alice/homelab-ipam:v0.1.0`. These are examples; substitute your actual owner, repository, and published digest/tag.

Configure Kanidm using the [README authentication instructions](../README.md#kanidm-authentication). Replace the values in `deploy/secret.example.yaml` without committing real secrets. Update the ingress hostname, class and TLS settings, and choose suitable block-backed persistent storage. Keep one replica and the `Recreate` strategy for SQLite.

### Private image pull credentials

Create a **personal access token (classic)** with `read:packages` for an account that can read the package. Authorize it for organization SSO if required. This pull token is separate from Actions' automatic publishing token. Store it using your cluster's secret-management system, or create an image pull Secret. Example commands below use Bash and the namespace `ipam`:

```bash
kubectl create namespace ipam
read -r -s -p 'GHCR read:packages token: ' GHCR_TOKEN
printf '\n'
kubectl -n ipam create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USERNAME \
  --docker-password="$GHCR_TOKEN"
unset GHCR_TOKEN
```

The Secret must be in the same namespace as the Deployment. Add this under `spec.template.spec` in `deploy/deployment.yaml` before applying it:

```yaml
imagePullSecrets:
  - name: ghcr-pull
```

For public packages, omit this Secret and `imagePullSecrets`. If the namespace already exists, skip namespace creation.

### Apply and update

After replacing the example configuration and image, apply the files in your chosen namespace:

```sh
kubectl -n ipam apply -f deploy/secret.example.yaml
kubectl -n ipam apply -f deploy/deployment.yaml
kubectl -n ipam apply -f deploy/ingress.example.yaml
kubectl -n ipam rollout status deployment/homelab-ipam
```

Create the namespace first if you skipped the private-pull commands. These commands do not create an ingress controller, TLS issuer/certificate, or storage provisioner; use your cluster's existing setup.

For subsequent builds, update the manifest's image and reapply it. To change a running deployment directly:

```sh
kubectl -n ipam set image deployment/homelab-ipam \
  ipam=ghcr.io/alice/homelab-ipam:sha-REPLACE_WITH_FULL_COMMIT_SHA
kubectl -n ipam rollout status deployment/homelab-ipam
```

Mirror that image change in your manifests/GitOps source. Publishing a new `latest` image does not restart existing pods, and the manifest's `IfNotPresent` policy can reuse a cached tag. A new digest or unique SHA tag avoids that ambiguity. Upgrades briefly stop the single SQLite-backed replica.

## Troubleshooting

- **Workflow does not run:** commit it to the default branch, check Actions policy, and check branch/tag filters. Fork pull requests may require maintainer approval.
- **GHCR push denied:** check job `packages: write`, organization policy, and the package's Actions access for this repository.
- **ImagePullBackOff:** check the exact lowercase package name, published tag/digest, package visibility, pull-token access, and pull-secret namespace.
- **Pod stays Pending:** check for an amd64 node and a bound PVC with compatible node/storage topology.
- **Login/configuration startup error:** configure the four OIDC variables and the exact callback URL; OIDC settings are runtime Secrets, not build arguments.

The workflow requires a real GitHub Actions run to verify registry permissions and publication. Local workflow linting cannot prove GHCR or cluster access.
