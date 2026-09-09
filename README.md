# Asistencia

Sistema de check-in para pasar lista. Los alumnos escriben su matrícula y la asistencia
se registra solo si están dentro del horario de una de sus materias. El profesor administra
materias, horarios, alumnos y consulta/exporta la asistencia desde `/admin` con contraseña.

## Stack

- Node.js 22 + Express (una sola función serverless en Vercel: `api/index.js`)
- Base de datos: [Turso](https://turso.tech) (libSQL, SQLite en la nube). En local, sin
  variables de entorno, se usa el archivo `data/asistencia.db`.
- Frontend estático en `public/` (sin frameworks).

## Correr en local

```bash
npm install
ADMIN_PASSWORD=mi-clave npm run dev
```

Abre <http://localhost:3000> (alumnos) y <http://localhost:3000/admin> (profesor).
La primera vez se cargan las materias, horarios y alumnos de `data/seed.json`.

Para probar el check-in fuera de horario puedes simular la hora:

```bash
APP_FAKE_NOW="2026-09-10T23:10:00Z" npm start   # jueves 17:10 hora de México
```

## Desplegar en Vercel

1. Importa este repositorio en Vercel.
2. En **Storage → Marketplace** agrega **Turso** y conéctalo al proyecto. Eso crea las
   variables `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`.
3. En **Settings → Environment Variables** agrega:
   - `ADMIN_PASSWORD`: contraseña del panel.
   - `SESSION_SECRET`: cadena aleatoria larga (`openssl rand -hex 32`).
   - `APP_TZ`: `America/Mexico_City` (o la zona que corresponda).
4. Deploy. La base se crea y se llena con `data/seed.json` en la primera petición.

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `ADMIN_PASSWORD` | Contraseña del panel `/admin`, mínimo 8 caracteres. **Obligatoria en producción** (en local, por defecto `admin`). |
| `SESSION_SECRET` | Secreto para firmar la cookie de sesión del admin (`openssl rand -hex 32`). **Obligatorio en producción**. |
| `APP_TZ` | Zona horaria para validar horarios. Por defecto `America/Mexico_City`. |
| `TURSO_DATABASE_URL` | URL `libsql://…` de Turso. Si falta en local se usa SQLite en archivo. |
| `TURSO_AUTH_TOKEN` | Token de Turso. |
| `APP_FAKE_NOW` | Solo pruebas: fecha ISO para simular la hora actual. |

## API

- `POST /api/checkin` `{ matricula }` → registra asistencia si hay clase en curso.
- `GET /api/estado` → hora del servidor en la zona configurada.
- `POST /api/admin/login` `{ password }` · `POST /api/admin/logout`
- `GET|POST|PUT|DELETE /api/admin/materias[/:id]`, `POST /api/admin/materias/:id/horarios`, `DELETE /api/admin/horarios/:id`
- `GET|POST|PUT|DELETE /api/admin/alumnos[/:id]`, `POST /api/admin/alumnos/importar`
- `GET /api/admin/asistencias?materia=&desde=&hasta=`, `POST|DELETE /api/admin/asistencias`, `GET /api/admin/asistencias/csv`
- `GET /api/admin/resumen`, `PUT /api/admin/ajustes`
