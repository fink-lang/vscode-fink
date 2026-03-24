.PHONY: deps-check deps-update deps-install clean build test release

deps-check:
	node deps.mjs check

deps-update:
	node deps.mjs update

deps-install:
	node deps.mjs install

clean:
	rm -rf ./build ./target

build: build-dir build-wasm build-ext build-grammars build-files build-languages

build-dir:
	mkdir -p ./build/pkg/grammars ./build/pkg/wasm

build-wasm:
	wasm-pack build --target web --weak-refs --out-dir build/pkg/wasm
	rm -f build/pkg/wasm/.gitignore build/pkg/wasm/package.json build/pkg/wasm/README.md build/pkg/wasm/*.d.ts build/pkg/wasm/fink_wasm_bg.js

build-ext:
	npx esbuild src/extension.ts --bundle --outfile=build/pkg/extension.js --external:vscode --format=cjs --platform=node

build-grammars:
	node -r @fink/require-hook ./scripts/build-grammars.fnk

build-files:
	node scripts/build-pkg-json.mjs
	cp ./README.md ./LICENSE ./build/pkg/
	mkdir -p ./build/pkg/images
	cp ./images/icon.png ./build/pkg/images/

build-languages:
	cp -r ./languages ./build/pkg/

test:
	@echo "no tests configured"

release:
	npx semantic-release
