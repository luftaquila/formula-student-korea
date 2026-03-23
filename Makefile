.PHONY: build deploy restart backup restore

PROFILE ?= production

build:
	-podman image prune -f --filter "dangling=true" 2>/dev/null
	podman compose --profile $(PROFILE) build $(if $(NO_CACHE),--no-cache) $(SVC)

deploy:
	-podman image prune -f --filter "dangling=true" 2>/dev/null
	podman compose --profile $(PROFILE) build $(if $(NO_CACHE),--no-cache) $(SVC)
	podman compose --profile $(PROFILE) up -d --force-recreate
	podman compose --profile $(PROFILE) restart caddy

restart:
	podman compose --profile $(PROFILE) up -d --force-recreate
	podman compose --profile $(PROFILE) restart caddy

backup:
	./scripts/backup.sh $(DEST)

restore:
	@test -n "$(ZIP)" || (echo "사용법: make restore ZIP=<백업파일.zip>" && exit 1)
	./scripts/restore.sh $(ZIP)
