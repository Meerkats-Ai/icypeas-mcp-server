# Icypeas MCP Server

This is a Model Context Protocol (MCP) server that integrates with the Icypeas API to provide work email finding capabilities.

## Features

- Find work emails using name and company information

## Setup

### Local Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file based on `.env.example` and add your Icypeas API key:
   ```
   ICYPEAS_API_KEY=your_api_key_here
   ```
4. Build the server:
   ```
   npm run build
   ```
5. Start the server:
   ```
   npm start
   ```

### Docker Setup

1. Clone this repository
2. Create a `.env` file with your Icypeas API key
3. Build and run using Docker Compose:
   ```
   docker-compose up -d
   ```

## MCP Configuration

To use this server with an MCP client, add the following configuration to your MCP settings file:

```json
{
  "mcpServers": {
    "icypeas": {
      "command": "node",
      "args": ["path/to/icypeas/dist/index.js"],
      "env": {
        "ICYPEAS_API_KEY": "your_api_key_here"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Available Tools

- `icypeas_find_work_email`: Find a work email using name and company information

## License

ISC
