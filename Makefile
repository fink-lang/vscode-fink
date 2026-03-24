.PHONY: deps-check deps-update deps-install clean build test release

deps-check:
	node deps.mjs check

deps-update:
	node deps.mjs update

deps-install:
	node deps.mjs install

clean:
	rm -rf ./build ./target

build:
	npm run build

test:
	@echo "no tests configured"

release:
	npm run release
