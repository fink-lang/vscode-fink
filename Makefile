.PHONY: deps-check deps-update deps-install clean build package test release

deps-check:
	node scripts/deps.mjs check

deps-update:
	node scripts/deps.mjs update

deps-install:
	node scripts/deps.mjs install

clean:
	rm -rf ./build ./target

build: build-wasm build-ext build-grammars build-files build-languages

build-wasm:
	mkdir -p ./build/pkg/wasm
	wasm-pack build --target web --weak-refs --out-dir build/pkg/wasm
	rm -f build/pkg/wasm/.gitignore build/pkg/wasm/package.json build/pkg/wasm/README.md build/pkg/wasm/*.d.ts build/pkg/wasm/fink_wasm_bg.js

build-ext:
	mkdir -p ./build/pkg
	npx esbuild src/extension.ts --bundle --outfile=build/pkg/extension.js --external:vscode --format=cjs --platform=node

build-grammars:
	mkdir -p ./build/pkg/grammars
	node -r @fink/require-hook ./scripts/build-grammars.fnk

build-files:
	mkdir -p ./build/pkg
	node scripts/build-pkg-json.mjs
	cp ./README.md ./LICENSE ./build/pkg/
	mkdir -p ./build/pkg/images
	cp ./.deps/brand/assets/fink-rounded.png ./build/pkg/images/icon.png

build-languages:
	mkdir -p ./build/pkg
	cp -r ./languages ./build/pkg/

package:
	cd build/pkg && npx vsce package --out ../../fink-extension.vsix

test:
	@echo "no tests configured"

release:
	npx semantic-release
