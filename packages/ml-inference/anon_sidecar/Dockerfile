FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    "fastapi>=0.115,<0.120" \
    "uvicorn[standard]>=0.32,<0.40" \
    "httpx>=0.27,<0.30" \
    "psycopg[binary]>=3.2,<3.3" \
    "pydantic>=2.9,<3.0"

COPY main.py /app/main.py

EXPOSE 7070

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7070"]
