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

ios-doctor: ## Report Xcode SDKs, runtimes and whether iOS destinations are eligible
	@echo "--- Xcode ---"; xcodebuild -version | head -2
	@echo; echo "--- iOS SDKs ---"; xcodebuild -showsdks 2>/dev/null | sed -n "/iOS/,/^$$/p" | head -8
	@echo; echo "--- simulator runtimes ---"; xcrun simctl list runtimes 2>/dev/null | tail -n +2
	@echo; echo "--- iPhone 12 devices ---"; xcrun simctl list devices available 2>/dev/null | grep -iE "iPhone 12|^-- iOS" || echo "  none"
	@echo; echo "--- destinations (must show ELIGIBLE simulators) ---"
	@cd ios && xcodebuild -project LightDB.xcodeproj -scheme LightDB -showdestinations 2>&1 | grep -A20 -iE "available destinations|ineligible" || true
	@echo; echo "If only ineligible destinations appear, run: make ios-platform"

.PHONY: ios-doctor

# --------------------------------------------------
# Physical device (USB-C or paired over Wi-Fi)
# --------------------------------------------------
#
# devicectl accepts a device name, UDID, ECID or serial, so DEVICE can just be
# the name shown by `make devices`.
#
# TEAM_ID is your Apple Developer Team ID. Unlike the simulator, a device build
# must be signed -- CODE_SIGNING_ALLOWED=NO produces a bundle iOS will refuse
# to install. `make team` lists the identities you have.

# Both are auto-detected, and both can be overridden:
#   make phone DEVICE="My iPhone" TEAM_ID=ABCDE12345
DEVICE      ?= $(shell xcrun devicectl list devices 2>/dev/null | awk '/available/ {print $$1; exit}')
TEAM_ID     ?= $(shell security find-identity -v -p codesigning 2>/dev/null | grep -oE '\([A-Z0-9]{10}\)' | head -1 | tr -d '()')
APP_BUNDLE  := ios/.build/xcode/Build/Products/Debug-iphoneos/LightDB.app
BUILD_LOG   := ios/.build/device-build.log

phone: ## Build, install and launch on your iPhone. One command, no arguments.
	@set -e; \
	if [ -z "$(DEVICE)" ]; then \
		echo "✗ No paired device found."; \
		echo "  Plug the phone in over USB-C, unlock it, and tap Trust if asked."; \
		echo "  Then check with: make devices"; \
		exit 1; \
	fi; \
	if cd ios && xcodebuild -project LightDB.xcodeproj -scheme LightDB \
		-showdestinations 2>&1 | grep -q "is not installed"; then \
		echo "✗ Xcode's iOS platform component is not installed."; \
		echo "  This blocks every iOS build, device and simulator alike."; \
		echo "  Fix with: make ios-platform   (large, one time)"; \
		exit 1; \
	fi; \
	cd $(CURDIR); \
	if [ -z "$(TEAM_ID)" ]; then \
		echo "✗ No code signing identity on this machine."; \
		echo "  A device build must be signed, and only Xcode can create the first"; \
		echo "  certificate:  Xcode -> Settings -> Accounts -> + -> your Apple ID"; \
		echo "  Then check with: make team"; \
		exit 1; \
	fi; \
	echo "→ device $(DEVICE) · team $(TEAM_ID)"; \
	mkdir -p ios/.build; \
	echo "→ building (log: $(BUILD_LOG))"; \
	cd ios && xcodebuild -project LightDB.xcodeproj -scheme LightDB \
		-destination "platform=iOS,name=$(DEVICE)" -configuration Debug \
		-derivedDataPath .build/xcode \
		DEVELOPMENT_TEAM=$(TEAM_ID) -allowProvisioningUpdates \
		build > device-build.log 2>&1 \
		|| { mv device-build.log .build/ 2>/dev/null; \
		     echo "✗ build failed:"; tail -25 $(CURDIR)/$(BUILD_LOG); exit 1; }; \
	mv device-build.log .build/ 2>/dev/null || true; \
	cd $(CURDIR); \
	echo "→ installing"; \
	xcrun devicectl device install app --device "$(DEVICE)" $(APP_BUNDLE) >/dev/null; \
	echo "→ launching"; \
	xcrun devicectl device process launch --device "$(DEVICE)" \
		--terminate-existing $(BUNDLE_ID) >/dev/null; \
	echo "✓ lightdb is running on $(DEVICE)"; \
	echo "  If it refuses to open: iPhone -> Settings -> General ->"; \
	echo "  VPN & Device Management -> trust your developer certificate."

devices: ## List paired physical devices
	xcrun devicectl list devices

team: ## List code signing identities, to find your TEAM_ID
	@security find-identity -v -p codesigning || true
	@echo
	@echo "The 10-character code in parentheses after the name is your TEAM_ID."

device-pair: ## Pair a device that is plugged in but not yet trusted
	xcrun devicectl manage pair --device $(DEVICE)

build-device: ## Build a signed Debug build for a physical device
	@test -n "$(TEAM_ID)" || (echo "TEAM_ID required. Run: make team"; exit 1)
	cd ios && xcodebuild -project LightDB.xcodeproj -scheme LightDB \
		-destination "platform=iOS,name=$(DEVICE)" -configuration Debug \
		-derivedDataPath .build/xcode \
		DEVELOPMENT_TEAM=$(TEAM_ID) \
		-allowProvisioningUpdates \
		build

install-device: ## Install the built app onto the device
	xcrun devicectl device install app --device $(DEVICE) $(APP_BUNDLE)

launch-device: ## Launch the installed app, replacing any running copy
	xcrun devicectl device process launch --device $(DEVICE) \
		--terminate-existing $(BUNDLE_ID)

run-device: build-device install-device launch-device ## Build, install and launch on the device

console-device: ## Launch attached to the console, streaming stdout to the terminal
	xcrun devicectl device process launch --device $(DEVICE) \
		--terminate-existing --console $(BUNDLE_ID)

.PHONY: phone devices team device-pair build-device install-device launch-device run-device console-device
