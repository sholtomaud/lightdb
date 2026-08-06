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
# First data row of the table, truncated at the column gap. devicectl reports
# several states -- "connected", "available (paired)" -- so matching on state is
# fragile, and matching /available/ would also match "unavailable". Taking the
# name column keeps single-spaced device names like "My iPhone" intact.
DEVICE      ?= $(shell xcrun devicectl list devices 2>/dev/null | awk 'NR>2 && NF {sub(/  +.*/,""); print; exit}')
# The Team ID lives in the certificate's organizationalUnitName. The code in
# parentheses in the common name looks identical in shape but is the
# certificate's own identifier -- passing that yields
# "No Account for Team ..." from a team that does not exist.
TEAM_ID     ?= $(shell security find-certificate -a -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject -nameopt multiline 2>/dev/null | sed -n 's/.*organizationalUnitName *= *//p' | head -1)
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
	if ! xcrun devicectl device process launch --device "$(DEVICE)" \
		--terminate-existing $(BUNDLE_ID) >/dev/null 2>&1; then \
		echo ""; \
		echo "  The app installed, but iOS will not launch it yet."; \
		echo "  A developer certificate has to be trusted on the device by hand:"; \
		echo ""; \
		echo "    Settings > General > VPN & Device Management"; \
		echo "      > DEVELOPER APP > your Apple ID > Trust"; \
		echo ""; \
		echo "  If that entry is missing, turn on Developer Mode first:"; \
		echo ""; \
		echo "    Settings > Privacy & Security > Developer Mode > On"; \
		echo "    (the phone restarts)"; \
		echo ""; \
		echo "  Then run: make launch-device      (no rebuild needed)"; \
		exit 1; \
	fi; \
	echo "✓ lightdb is running on $(DEVICE)"

devices: ## List paired physical devices
	xcrun devicectl list devices

team: ## Show code signing identities and the detected TEAM_ID
	@security find-identity -v -p codesigning || true
	@echo
	@echo "Detected TEAM_ID: $(TEAM_ID)"
	@echo
	@echo "Read from the certificate's organizationalUnitName, not from the code"
	@echo "in parentheses above -- that one is the certificate's own identifier."

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
