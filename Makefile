.PHONY: build deploy restart backup restore

PROFILE ?= production
# caddy 서비스는 프로파일별로 다르다 (production: caddy, local: caddy-local)
CADDY_SVC := $(if $(filter local,$(PROFILE)),caddy-local,caddy)

build:
	-podman image prune -f --filter "dangling=true" 2>/dev/null
	podman compose --profile $(PROFILE) build $(if $(NO_CACHE),--no-cache) $(SVC)

deploy:
	-podman image prune -f --filter "dangling=true" 2>/dev/null
	podman compose --profile $(PROFILE) pull $(SVC)
	podman compose --profile $(PROFILE) up -d --force-recreate $(SVC)
	$(if $(filter $(CADDY_SVC),$(SVC)),,podman compose --profile $(PROFILE) restart $(CADDY_SVC))

restart:
	podman compose --profile $(PROFILE) up -d --force-recreate
	podman compose --profile $(PROFILE) restart $(CADDY_SVC)

backup:
	./scripts/backup.sh $(DEST)

restore:
	@test -n "$(ZIP)" || (echo "사용법: make restore ZIP=<백업파일.zip>" && exit 1)
	./scripts/restore.sh $(ZIP)
