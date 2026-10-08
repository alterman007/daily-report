# 团队日报镜像
#   make build
#   make push REGISTRY=registry.example.com/team
#   make up

IMAGE ?= daily-report
TAG ?= latest
REGISTRY ?= ccr.ccs.tencentyun.com/citydo

ifeq ($(strip $(REGISTRY)),)
IMAGE_REF := $(IMAGE):$(TAG)
else
IMAGE_REF := $(REGISTRY)/$(IMAGE):$(TAG)
endif

export IMAGE_REF

.PHONY: build push up down logs restart dev

build:
	docker compose build

push: build
	docker compose push

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

restart:
	docker compose restart

dev:
	npm start
