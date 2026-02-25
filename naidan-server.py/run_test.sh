#!/bin/bash
# Run naidan-server tests across multiple Python versions.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Common reporting logic
report() {
  if [ $1 -eq 0 ]; then
    echo -e "${GREEN}[✓] $2 passed${NC}"
  else
    echo -e "${RED}[✗] $2 failed${NC}"
    exit 1
  fi
}

echo "Starting isolated tests..."

# Test Python 3.9
echo "Testing Python 3.9..."
docker run --rm --network none -v "$DIR:/src:ro" python:3.9-slim \
  bash -c "mkdir /app && cp /src/*.py /app/ && cd /app && python3 test_server.py"
report $? "Python 3.9"

# Test Python 3.14 (Release Candidate)
echo "Testing Python 3.14..."
docker run --rm --network none -v "$DIR:/src:ro" python:3.14-slim \
  bash -c "mkdir /app && cp /src/*.py /app/ && cd /app && python3 test_server.py"
report $? "Python 3.14"
