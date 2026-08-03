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

# --------------------------------------------------
# Cross-language protocol conformance
# --------------------------------------------------

vectors: start ## Regenerate spec/vectors/ from the TypeScript implementation
	$(CONTAINER_BIN) run --rm -v $(shell pwd):$(WORKDIR) $(IMAGE_APP) node tools/generate-vectors.ts

test-ios: ## Run LightDBKit conformance tests (host Xcode, not the container)
	cd ios/LightDBKit && swift test

build-ios: ## Build the SwiftUI app for the iOS simulator (host Xcode)
	cd ios && xcodebuild -project LightDB.xcodeproj -scheme LightDB \
		-destination "generic/platform=iOS Simulator" -configuration Debug \
		CODE_SIGNING_ALLOWED=NO build
.PHONY: vectors test-ios build-ios

SIM_NAME ?= iPhone 12 mini
SIM_OS   ?= 18.5
BUNDLE_ID := dev.lightdb.LightDB

ios-platform: ## Download the Xcode iOS platform component (multi-GB, one time)
	xcodebuild -downloadPlatform iOS

sim-boot: ## Boot the simulator and open the Simulator app
	-xcrun simctl boot "$(SIM_NAME)"
	open -a Simulator

run-ios: sim-boot ## Build, install and launch the app on the simulator
	cd ios && xcodebuild -project LightDB.xcodeproj -scheme LightDB \
		-destination "platform=iOS Simulator,name=$(SIM_NAME),OS=$(SIM_OS)" \
		-derivedDataPath .build/xcode -configuration Debug \
		CODE_SIGNING_ALLOWED=NO build
	xcrun simctl install booted ios/.build/xcode/Build/Products/Debug-iphonesimulator/LightDB.app
	xcrun simctl launch booted $(BUNDLE_ID)

.PHONY: ios-platform sim-boot run-ios
