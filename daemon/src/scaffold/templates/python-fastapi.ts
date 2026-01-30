import { StackTemplate } from '../types';

export const pythonFastapiTemplate: StackTemplate = {
  id: 'python-fastapi',
  name: 'Python + FastAPI',
  description: 'Modern Python API with FastAPI, async support, and auto-generated docs',
  type: 'backend',
  icon: '🐍',
  tags: ['python', 'fastapi', 'backend', 'api', 'async'],
  scoring: {
    primaryKeywords: ['python', 'fastapi', 'uvicorn', 'pydantic'],
    secondaryKeywords: ['async', 'api', 'ml', 'machine learning', 'data', 'science', 'model'],
    useCases: ['python api', 'fastapi service', 'python ml service', 'python backend', 'data api', 'machine learning api'],
    typeSignals: { python: 3, ml: 2, 'machine learning': 2, data: 1, science: 1 },
  },
  files: [
    {
      path: 'pyproject.toml',
      template: `[project]
name = "{{projectName}}"
version = "0.1.0"
description = "{{projectDescription}}"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.32.0",
    "pydantic>=2.9.0",
    "python-dotenv>=1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3.0",
    "pytest-asyncio>=0.24.0",
    "httpx>=0.27.0",
    "ruff>=0.7.0",
]

[tool.ruff]
line-length = 88
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W"]

[tool.pytest.ini_options]
asyncio_mode = "auto"`,
    },
    {
      path: 'app/__init__.py',
      template: `"""{{projectName}} - {{projectDescription}}"""

__version__ = "0.1.0"`,
    },
    {
      path: 'app/main.py',
      template: `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import api

app = FastAPI(
    title="{{projectName}}",
    description="{{projectDescription}}",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api.router, prefix="/api")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "Welcome to {{projectName}}"}`,
    },
    {
      path: 'app/routers/__init__.py',
      template: `"""API routers."""`,
    },
    {
      path: 'app/routers/api.py',
      template: `from fastapi import APIRouter

router = APIRouter()


@router.get("/")
async def api_root():
    """API root endpoint."""
    return {"message": "API v1"}


# Add your routes here
# @router.get("/items")
# async def get_items():
#     return {"items": []}`,
    },
    {
      path: 'app/models/__init__.py',
      template: `"""Pydantic models."""`,
    },
    {
      path: 'app/models/schemas.py',
      template: `from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Health check response."""
    status: str


class MessageResponse(BaseModel):
    """Generic message response."""
    message: str


# Add your models here
# class Item(BaseModel):
#     id: int
#     name: str
#     description: str | None = None`,
    },
    {
      path: 'app/services/__init__.py',
      template: `"""Business logic services."""`,
    },
    {
      path: 'tests/__init__.py',
      template: `"""Tests for {{projectName}}."""`,
    },
    {
      path: 'tests/test_main.py',
      template: `import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test"
    ) as ac:
        yield ac


@pytest.mark.asyncio
async def test_health(client: AsyncClient):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_root(client: AsyncClient):
    response = await client.get("/")
    assert response.status_code == 200
    assert "message" in response.json()`,
    },
    {
      path: '.env',
      template: `# Environment variables
DEBUG=true
HOST=0.0.0.0
PORT=8000`,
    },
    {
      path: '.env.example',
      template: `# Environment variables
DEBUG=true
HOST=0.0.0.0
PORT=8000`,
    },
    {
      path: '.gitignore',
      template: `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
dist/
*.egg-info/
.eggs/

# Virtual environments
venv/
.venv/
ENV/

# Environment
.env
.env.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# Testing
.pytest_cache/
.coverage
htmlcov/

# OS
.DS_Store`,
    },
    {
      path: 'CLAUDE.md',
      template: `# {{projectName}}

{{projectDescription}}

## Tech Stack
- Python 3.11+
- FastAPI for async web framework
- Pydantic for data validation
- Uvicorn for ASGI server

## Project Structure
\`\`\`
app/
├── __init__.py
├── main.py          # FastAPI app setup
├── routers/         # API route handlers
│   └── api.py
├── models/          # Pydantic schemas
│   └── schemas.py
└── services/        # Business logic
tests/
└── test_main.py     # API tests
\`\`\`

## Commands
- \`uv run uvicorn app.main:app --reload\` - Start dev server
- \`uv run pytest\` - Run tests
- \`uv run ruff check .\` - Lint code
- \`uv run ruff format .\` - Format code

## API Docs
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Development Notes
- Add routes in \`app/routers/\`
- Add Pydantic models in \`app/models/\`
- Add business logic in \`app/services/\`
- Environment variables in \`.env\``,
    },
    {
      path: 'README.md',
      template: `# {{projectName}}

{{projectDescription}}

## Getting Started

\`\`\`bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or venv\\Scripts\\activate on Windows

# Install dependencies
pip install -e ".[dev]"

# Run server
uvicorn app.main:app --reload
\`\`\`

Server will start at http://localhost:8000

API docs available at http://localhost:8000/docs

## Scripts

- \`uvicorn app.main:app --reload\` - Development server
- \`pytest\` - Run tests
- \`ruff check .\` - Lint code
- \`ruff format .\` - Format code`,
    },
  ],
  postCreate: [
    {
      command: 'python -m venv venv && . venv/bin/activate && pip install -e ".[dev]"',
      description: 'Creating virtual environment and installing dependencies',
    },
  ],
  recommendedSkills: ['test', 'dev'],
};
