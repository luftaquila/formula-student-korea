.PHONY: build deploy restart

PROFILE ?= production

build:
	-podman image prune -f
	podman compose --profile $(PROFILE) build $(SVC)

deploy:
	-podman image prune -f
	podman compose --profile $(PROFILE) build $(SVC)
	podman compose --profile $(PROFILE) up -d
	podman compose --profile $(PROFILE) restart caddy

restart:
	podman compose --profile $(PROFILE) up -d
	podman compose --profile $(PROFILE) restart caddy
