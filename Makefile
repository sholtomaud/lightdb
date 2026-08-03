IMAGE_APP        := lightdb
CONTAINER_BIN    := container
NODE_VERSION     := $(shell cat .node-version)
WORKDIR          := /app

.PHONY: help start image install dev build-app test-unit test lint clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

# --------------------------------------------------
# Container daemon
# --------------------------------------------------

start: ## Start the Apple container system daemon
	$(CONTAINER_BIN) system start

# --------------------------------------------------
# Container image
# --------------------------------------------------

image: start ## Build dev container image (node:$(NODE_VERSION)-slim)
	$(CONTAINER_BIN) build -f Containerfile -t $(IMAGE_APP) --build-arg NODE_VERSION=$(NODE_VERSION) .

# --------------------------------------------------
# Compilation and serving targets
# --------------------------------------------------

install: start ## Run package installation inside container
	$(CONTAINER_BIN) run --rm -v $(shell pwd):$(WORKDIR) $(IMAGE_APP) npm install

dev: start ## Start Vite dev server inside container
	$(CONTAINER_BIN) run --rm -it -p 5173:5173 -v $(shell pwd):$(WORKDIR) --name lightdb-dev $(IMAGE_APP) npm run dev

build-app: start ## Compile optimized static assets (Vite)
	$(CONTAINER_BIN) run --rm -v $(shell pwd):$(WORKDIR) $(IMAGE_APP) npm run build

test-unit: start ## Run node --test unit tests inside container
	$(CONTAINER_BIN) run --rm -v $(shell pwd):$(WORKDIR) $(IMAGE_APP) npm run test:unit

test: start ## Run Playwright E2E integration tests inside container
	$(CONTAINER_BIN) run --rm -it -p 5173:5173 -v $(shell pwd):$(WORKDIR) $(IMAGE_APP) npm run test

lint: start ## Run eslint inside container
	$(CONTAINER_BIN) run --rm -v $(shell pwd):$(WORKDIR) $(IMAGE_APP) npm run lint

clean: ## Clear compiled directories and node dependencies
	rm -rf node_modules dist .vite playwright-report test-results
