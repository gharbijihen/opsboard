param(
  [string]$AppName = "opsboard",
  [string]$Region = "eu-west-3",
  [string]$StackName = "opsboard-prod",
  [string]$GitHubOwner = "gharbijihen",
  [string]$GitHubRepo = "exercice-aws",
  [string]$BranchName = "main",
  [string]$RoleName = "",
  [string]$Profile = ""
)

$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($Profile)) {
  $env:AWS_PROFILE = $Profile
}

function Find-AwsCli {
  foreach ($name in @("aws.cmd", "aws.exe", "aws")) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      return $command.Source
    }
  }

  throw "AWS CLI was not found in PATH."
}

$AwsCli = Find-AwsCli

function Invoke-Aws {
  & $script:AwsCli @args
  if ($LASTEXITCODE -ne 0) {
    throw "AWS CLI failed: aws $($args -join ' ')"
  }
}

function Test-AwsCommand {
  & $script:AwsCli @args *> $null
  return $LASTEXITCODE -eq 0
}

if ([string]::IsNullOrWhiteSpace($RoleName)) {
  $RoleName = "$AppName-github-actions"
}

$AccountId = Invoke-Aws sts get-caller-identity --query Account --output text
$ProviderArn = "arn:aws:iam::$AccountId`:oidc-provider/token.actions.githubusercontent.com"

$ExistingProvider = Invoke-Aws iam list-open-id-connect-providers `
  --query "OpenIDConnectProviderList[?Arn=='$ProviderArn'].Arn | [0]" `
  --output text

if ($ExistingProvider -eq "None") {
  Invoke-Aws iam create-open-id-connect-provider `
    --url https://token.actions.githubusercontent.com `
    --client-id-list sts.amazonaws.com `
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
}

$SubjectPattern = "repo:$GitHubOwner*/$GitHubRepo`*:ref:refs/heads/$BranchName"
$TrustPolicy = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Effect = "Allow"
      Principal = @{
        Federated = $ProviderArn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = @{
        StringEquals = @{
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = @{
          "token.actions.githubusercontent.com:sub" = $SubjectPattern
        }
      }
    }
  )
} | ConvertTo-Json -Depth 20

$TrustPolicyFile = Join-Path $env:TEMP "$AppName-github-trust-policy.json"
$TrustPolicy | Out-File -Encoding utf8 $TrustPolicyFile

if (Test-AwsCommand iam get-role --role-name $RoleName) {
  Invoke-Aws iam update-assume-role-policy --role-name $RoleName --policy-document "file://$TrustPolicyFile"
} else {
  Invoke-Aws iam create-role --role-name $RoleName --assume-role-policy-document "file://$TrustPolicyFile"
}

Remove-Item -LiteralPath $TrustPolicyFile -Force

$outputs = Invoke-Aws cloudformation describe-stacks `
  --stack-name $StackName `
  --region $Region `
  --query "Stacks[0].Outputs" `
  --output json | ConvertFrom-Json

function Get-OutputValue {
  param([string]$Key)
  return ($script:outputs | Where-Object { $_.OutputKey -eq $Key } | Select-Object -First 1).OutputValue
}

$TaskExecutionRoleArn = Get-OutputValue "TaskExecutionRoleArn"
$TaskRoleArn = Get-OutputValue "TaskRoleArn"
$StackArn = "arn:aws:cloudformation:$Region`:$AccountId`:stack/$StackName/*"
$BackendRepositoryArn = Invoke-Aws ecr describe-repositories `
  --repository-names "$AppName-backend" `
  --region $Region `
  --query "repositories[0].repositoryArn" `
  --output text
$FrontendRepositoryArn = Invoke-Aws ecr describe-repositories `
  --repository-names "$AppName-frontend" `
  --region $Region `
  --query "repositories[0].repositoryArn" `
  --output text

$PermissionsPolicy = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Sid = "EcrLogin"
      Effect = "Allow"
      Action = @("ecr:GetAuthorizationToken")
      Resource = "*"
    },
    @{
      Sid = "PushExerciseImages"
      Effect = "Allow"
      Action = @(
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeRepositories",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      )
      Resource = @($BackendRepositoryArn, $FrontendRepositoryArn)
    },
    @{
      Sid = "DeployEcsServices"
      Effect = "Allow"
      Action = @(
        "ecs:DescribeServices",
        "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition",
        "ecs:UpdateService"
      )
      Resource = "*"
    },
    @{
      Sid = "PassExistingEcsTaskRoles"
      Effect = "Allow"
      Action = @("iam:PassRole")
      Resource = @($TaskExecutionRoleArn, $TaskRoleArn)
    },
    @{
      Sid = "ReadStackOutputs"
      Effect = "Allow"
      Action = @(
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary"
      )
      Resource = $StackArn
    },
    @{
      Sid = "ReconcileStack"
      Effect = "Allow"
      Action = @(
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ValidateTemplate"
      )
      Resource = $StackArn
    },
    @{
      Sid = "ReconcileNetworkingAndCompute"
      Effect = "Allow"
      Action = @(
        "ec2:*",
        "elasticloadbalancing:*",
        "rds:*",
        "logs:*",
        "application-autoscaling:*",
        "ecs:CreateCluster",
        "ecs:DescribeClusters",
        "ecs:CreateService",
        "ecs:DeleteService",
        "ecs:TagResource"
      )
      Resource = "*"
    },
    @{
      Sid = "ReconcileSecrets"
      Effect = "Allow"
      Action = @(
        "secretsmanager:CreateSecret",
        "secretsmanager:UpdateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:TagResource"
      )
      Resource = "*"
    },
    @{
      Sid = "ReconcileIamRoles"
      Effect = "Allow"
      Action = @(
        "iam:CreateRole",
        "iam:GetRole",
        "iam:TagRole",
        "iam:AttachRolePolicy",
        "iam:PutRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:GetRolePolicy"
      )
      Resource = "*"
    }
  )
} | ConvertTo-Json -Depth 20

$PermissionsPolicyFile = Join-Path $env:TEMP "$AppName-github-permissions-policy.json"
$PermissionsPolicy | Out-File -Encoding utf8 $PermissionsPolicyFile

Invoke-Aws iam put-role-policy `
  --role-name $RoleName `
  --policy-name "$AppName-github-actions-deploy" `
  --policy-document "file://$PermissionsPolicyFile"

Remove-Item -LiteralPath $PermissionsPolicyFile -Force

Write-Host "GitHub secret for automatic CI/CD:"
Write-Host "AWS_ROLE_TO_ASSUME=arn:aws:iam::$AccountId`:role/$RoleName"
