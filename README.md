# OpsBoard

OpsBoard is a small production-style incident board built for the technical exercise. It includes a browser UI, backend API, PostgreSQL database, health/readiness probes, metrics, tests, Docker, CI/CD, and AWS deployment scripts.

## Current Deployment

The active deployment runs on **ECS Fargate** (`infra/aws/`), deployed automatically by GitHub Actions on every push to `main`:

```text
http://opsboard-alb-854896720.eu-west-3.elb.amazonaws.com
```

An EKS (Kubernetes) deployment path also exists (`infra/eks/`) and was fully tested and validated, but is **not currently deployed** — it was torn down after validation to avoid running two environments at once. See "AWS EKS Deployment" below to redeploy it if needed.

## Architecture

```mermaid
flowchart LR
  B[Browser] --> L[Application Load Balancer]
  L --> F[ECS Fargate frontend: Nginx]
  L --> A[ECS Fargate backend: Node.js API]
  A --> P[(RDS PostgreSQL)]
  F --> W[CloudWatch Logs]
  A --> W
  G[GitHub Actions] --> R[Amazon ECR]
  R --> F
  R --> A
```

Docker Compose runs the complete local stack: frontend container, backend container, and PostgreSQL. AWS deployment provisions Amazon RDS for PostgreSQL, stores runtime secrets in AWS Secrets Manager, runs frontend and backend on ECS Fargate, exposes the app through an Application Load Balancer, and uses Amazon ECR for Docker images.

## Project Structure

```text
frontend/                    Browser UI
backend/                     API, database code, tests, load script
.github/workflows/ci-cd.yml  One GitHub Actions CI/CD pipeline
infra/aws/                   AWS ECS Fargate deployment scripts and CloudFormation
infra/eks/                   AWS EKS (Kubernetes) deployment scripts and manifests
docs/                        Architecture, API, deployment, checklist
frontend/Dockerfile          Frontend Nginx image
backend/Dockerfile           Backend Node.js API image
docker-compose.yml           Local app + PostgreSQL stack
```

## Features

- Incident dashboard with status and priority summaries.
- Create incident flow with backend validation.
- Status workflow: open, in progress, resolved.
- Search and filters.
- Backend exposes `/healthz`, `/readyz`, `/metrics`, and `/openapi.yaml`.
- PostgreSQL-backed persistence for the normal Docker/AWS path.
- Optional bearer-token protection for write endpoints through `ADMIN_TOKEN`.
- JSON structured logs to stdout for CloudWatch Logs.
- Dependency-free local tests and load smoke test.

## Tech Stack

- Runtime: Node.js 24.
- UI: browser-native HTML, CSS, and JavaScript.
- API: Node.js HTTP server.
- Data: PostgreSQL through `DATABASE_URL`; file mode exists only for tests and emergency local fallback.
- Containers: Docker.
- CI/CD: GitHub Actions.
- Cloud: AWS ECS Fargate, Amazon ECR, Amazon RDS for PostgreSQL, AWS Secrets Manager, Application Load Balancer, CloudWatch Logs.

## Local Commands

Install dependencies:

```powershell
npm install --prefix backend
```

Run the full local stack with PostgreSQL:

```powershell
docker compose up --build
```

Open:

```text
http://127.0.0.1:8080
```

Run the Node app directly against your own PostgreSQL:

```powershell
$env:DATABASE_URL="postgresql://opsboard:opsboard@127.0.0.1:5432/opsboard"
$env:DATABASE_SSL="false"
npm start
```

Developer fallback without PostgreSQL:

```powershell
$env:DATA_FILE=":memory:"
npm start
```

Run checks:

```powershell
npm run check
```

Run load smoke test:

```powershell
$env:TARGET_URL="http://127.0.0.1:8080"
npm run load:local
```

## API

OpenAPI spec: `docs/api/openapi.yaml`

Main endpoints:

- `GET /api/incidents`
- `POST /api/incidents`
- `PATCH /api/incidents/{id}/status`
- `GET /api/stats`
- `GET /healthz`
- `GET /readyz`
- `GET /metrics`

## AWS Deployment

Full deployment guide: `docs/deployment.md`

PowerShell:

```powershell
.\infra\aws\deploy.ps1 -AppName opsboard -Region eu-west-3 -AdminToken "replace-with-strong-token"
```

The script creates:

- Amazon ECR repositories for frontend and backend images.
- Amazon RDS for PostgreSQL.
- AWS Secrets Manager secrets for `DATABASE_URL` and `ADMIN_TOKEN`.
- ECS Fargate cluster, task definitions, and services.
- Application Load Balancer with path routing.
- CloudWatch log groups.
- Autoscaling policies for frontend and backend services.

The database is created with PostgreSQL, encryption at rest, private network access, and 7-day backup retention. The stack uses small instance/task sizes to keep the exercise cost reasonable.

## AWS EKS Deployment (Alternative, not currently deployed)

An alternative deployment path runs the same images on a self-managed Amazon EKS cluster instead of ECS Fargate. It was built, deployed, and validated end-to-end, then torn down to avoid double billing while ECS Fargate is the active environment. Redeploy it with:

```powershell
.\infra\eks\deploy.ps1 -AppName opsboard -Region eu-west-3 -AdminToken "replace-with-strong-token"
```

Full guide, cost notes, and prerequisites: `docs/deployment-eks.md`. This path costs more than ECS Fargate (fixed control plane, NAT gateway, and always-on EC2 nodes) — use it only if you specifically need a Kubernetes cluster.

## Change Management (GitOps Principle)

All infrastructure changes should go through `infra/aws/cloudformation.yml` on `main`, deployed via CI/CD — not the AWS console or ad-hoc CLI commands. Manual changes are only for emergencies, and should be followed up with a matching commit so the template stays the source of truth.

`.github/workflows/reconcile.yml` enforces this automatically: a scheduled job (daily, plus manual `workflow_dispatch`) re-applies the CloudFormation stack from whatever is on `main`. Since `aws cloudformation deploy` is idempotent, this is a no-op when nothing has drifted, and silently reverts any manual change back to what's declared in the repository. It reads the currently-running ECS image from the live services (not the stack's own parameters, which are only set once at bootstrap) so it never undoes a real CI/CD deployment — it only corrects drift in everything else (security groups, ALB rules, RDS settings, IAM roles, autoscaling policies).

This requires the GitHub Actions deploy role to hold broad AWS write permissions (`ec2:*`, `elasticloadbalancing:*`, `rds:*`, etc. — see `infra/aws/create-github-oidc-role.ps1`), since CloudFormation acts with the caller's own permissions on every resource type in the template.

## GitHub Actions

One workflow handles both CI and CD:

```text
.github/workflows/ci-cd.yml
```

The validation job runs on pull requests and main branch pushes. It installs backend dependencies, lints, tests, audits dependencies, validates Docker Compose, and builds both Docker images.

The deployment job runs automatically after validation on every push to `main`. It assumes an AWS IAM role through GitHub OIDC, builds and pushes the frontend and backend images to Amazon ECR, registers new ECS task definition revisions, updates both ECS services, waits for service stability, then verifies `/healthz` and `/readyz` through the public load balancer URL.

Automatic deployment flow:

```text
change code
commit
push to main
GitHub Actions validates the app
GitHub Actions deploys new frontend and backend images to AWS ECS
GitHub Actions smoke-tests the public URL
```

Deployment workflow expects this GitHub secret:

- `AWS_ROLE_TO_ASSUME`

Deployment workflow expects these GitHub variables:

- `AWS_REGION`
- `AWS_STACK_NAME`
- `AWS_ECR_BACKEND_REPOSITORY`
- `AWS_ECR_FRONTEND_REPOSITORY`
- `AWS_ECS_CLUSTER`
- `AWS_ECS_BACKEND_SERVICE`
- `AWS_ECS_FRONTEND_SERVICE`
- `AWS_BACKEND_TASK_FAMILY`
- `AWS_FRONTEND_TASK_FAMILY`

The first infrastructure deployment should be done with `infra/aws/deploy.ps1`. After that, the GitHub Actions deployment workflow updates the existing ECS services with each push to `main`.

## Exercise Checklist

The requirement-to-evidence checklist is in `docs/exercise-checklist.md`.

## Security

- Write APIs require `Authorization: Bearer <ADMIN_TOKEN>` when `ADMIN_TOKEN` is configured.
- Repeated wrong bearer tokens from the same IP are rate limited (`AUTH_RATE_LIMIT_MAX`, default 10 per 5 minutes) to slow down brute-forcing `ADMIN_TOKEN`; requests using the correct token are never penalized by this limiter.
- Secrets are read only from environment variables or AWS Secrets Manager.
- Input validation is enforced server-side.
- Security headers include CSP, frame protection, MIME sniffing protection, referrer policy, and permissions policy.
- No sensitive data is logged intentionally.
- Use `npm audit` in CI after dependencies are installed.
- Both Docker images are scanned for CRITICAL/HIGH vulnerabilities in CI (Trivy) — the build fails if a fixable one is found. Amazon ECR also scans images on push.

## Milestone Plan

1. Foundation: repo, folder structure, app objective, architecture docs, first commit.
2. Backend: API, validation, storage adapter, health/readiness, metrics.
3. Frontend: dashboard, create form, filters, status workflow.
4. Quality: unit tests, integration tests, e2e smoke test, linting.
5. Delivery: separate frontend/backend Dockerfiles, Compose, GitHub Actions, AWS scripts.
6. Evidence: deploy URL, load-test result, scaling notes, known limitations.

## Acceptance Criteria

- `npm run check` passes.
- `docker compose up --build` serves the UI on port 8080.
- `/healthz` and `/readyz` return 200.
- A new incident can be created and resolved from the UI.
- AWS Application Load Balancer URL is publicly reachable.
- GitHub Actions deploys automatically on push to `main`.
- Load-test notes document behavior under increased traffic.

## Known Limitations

- File storage is intentionally limited to tests and emergency fallback. The delivered stack uses PostgreSQL.
- Authentication is intentionally lightweight for the exercise. A production user-facing system should use Cognito, OAuth/OIDC, or another managed identity provider.
- The default AWS deployment exposes HTTP through the generated load balancer URL. For stricter production use, attach an ACM certificate and custom domain for HTTPS.
