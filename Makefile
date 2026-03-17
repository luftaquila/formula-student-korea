.PHONY: build deploy restart

PROFILE ?= production

build:
	-podman image prune -f
	podman compose --profile $(PROFILE) build $(if $(NO_CACHE),--no-cache) $(SVC)

deploy:
	-podman image prune -f
	podman compose --profile $(PROFILE) build $(if $(NO_CACHE),--no-cache) $(SVC)
	podman compose --profile $(PROFILE) up -d --force-recreate
	podman compose --profile $(PROFILE) restart caddy

restart:
	podman compose --profile $(PROFILE) up -d --force-recreate
	podman compose --profile $(PROFILE) restart caddy
