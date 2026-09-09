# HM84 — Strava Dashboard

Painel pessoal para acompanhar o ciclo de meia maratona de 1h27 para 1h24.

## Fluxo
Garmin → Strava → HM84.

## Implementado
- OAuth2 do Strava
- importação das últimas 50 atividades
- refresh automático de token
- PostgreSQL
- webhook para create/update/delete
- dashboard responsivo
- base pronta para comparar planejado × executado

## Deploy
Projeto preparado para Render com `render.yaml`.

## Segurança
Client Secret, access token e refresh token ficam apenas no backend/variáveis de ambiente.
