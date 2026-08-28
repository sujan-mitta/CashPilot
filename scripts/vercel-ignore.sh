#!/bin/bash

# Vercel Ignored Build Step Script
# Exit code 1: Proceed with the build
# Exit code 0: Cancel the build

# Check if the commit author is the repository owner
if [ "$VERCEL_GIT_COMMIT_AUTHOR_LOGIN" = "sujan-mitta" ]; then
  echo "Commit by owner ($VERCEL_GIT_COMMIT_AUTHOR_LOGIN). Proceeding with build..."
  exit 1
else
  echo "Commit by contributor ($VERCEL_GIT_COMMIT_AUTHOR_LOGIN). Skipping build..."
  exit 0
fi
