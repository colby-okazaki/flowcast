FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ingest ./ingest
RUN useradd --create-home flowcast
USER flowcast
ENTRYPOINT ["python", "-m", "ingest.main"]
