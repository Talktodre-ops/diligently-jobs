---
date: 2026-11-12
status: accepted
tags: [testing, storage, docker]
---

# The MinIO image could not be pulled

`docker pull minio/minio` returned "repository does not exist or may require
docker login", and `quay.io/minio/minio` returned 401. The test services use
`chrislusf/seaweedfs` with `server -s3` instead. If an S3 emulator ever fails to
pull again, check the vendor's distribution notes before assuming a network
problem.
