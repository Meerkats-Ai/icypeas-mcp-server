#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  Tool,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Tool definitions
const FIND_WORK_EMAIL_TOOL: Tool = {
  name: 'icypeas_find_work_email',
  description: 'Find a work email using name and company information.',
  inputSchema: {
    type: 'object',
    properties: {
      firstname: {
        type: 'string',
        description: 'The first name of the person',
      },
      lastname: {
        type: 'string',
        description: 'The last name of the person',
      },
      domainOrCompany: {
        type: 'string',
        description: 'The domain or company name',
      }
    },
    required: ['firstname', 'lastname', 'domainOrCompany'],
  },
};

// Type definitions
interface FindWorkEmailParams {
  firstname: string;
  lastname: string;
  domainOrCompany: string;
}

interface EmailSearchResponse {
  success: boolean;
  item: {
    status: string;
    _id: string;
  };
}

interface EmailSearchResult {
  success: boolean;
  items: Array<{
    name: string;
    user: string;
    results: {
      firstname: string;
      lastname: string;
      gender: string;
      fullname: string;
      emails: Array<{
        email: string;
        certainty: string;
        mxRecords: string[];
        mxProvider: string;
      }>;
      phones: any[];
      saasServices: any[];
    };
    order: number;
    status: string;
    userData: {
      webhookUrl: string;
      externalId: string;
    };
    system: {
      createdAt: string;
      modifiedAt: string;
    };
    _id: string;
  }>;
  sorts: any[][];
  total: number;
}

// Type guards
function isFindWorkEmailParams(args: unknown): args is FindWorkEmailParams {
  if (
    typeof args !== 'object' ||
    args === null ||
    !('firstname' in args) ||
    typeof (args as { firstname: unknown }).firstname !== 'string' ||
    !('lastname' in args) ||
    typeof (args as { lastname: unknown }).lastname !== 'string' ||
    !('domainOrCompany' in args) ||
    typeof (args as { domainOrCompany: unknown }).domainOrCompany !== 'string'
  ) {
    return false;
  }

  return true;
}

// Server implementation
const server = new Server(
  {
    name: 'icypeas-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

// Get API key from environment variables
const ICYPEAS_API_KEY = process.env.ICYPEAS_API_KEY;
const ICYPEAS_API_URL = 'https://app.icypeas.com/api';

// Check if API key is provided
if (!ICYPEAS_API_KEY) {
  console.error('Error: ICYPEAS_API_KEY environment variable is required');
  process.exit(1);
}

// Configuration for retries and monitoring
const CONFIG = {
  retry: {
    maxAttempts: Number(process.env.ICYPEAS_RETRY_MAX_ATTEMPTS) || 3,
    initialDelay: Number(process.env.ICYPEAS_RETRY_INITIAL_DELAY) || 1000,
    maxDelay: Number(process.env.ICYPEAS_RETRY_MAX_DELAY) || 10000,
    backoffFactor: Number(process.env.ICYPEAS_RETRY_BACKOFF_FACTOR) || 2,
  },
};

// Initialize Axios instance for API requests
const apiClient: AxiosInstance = axios.create({
  baseURL: ICYPEAS_API_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `${ICYPEAS_API_KEY}`
  }
});

let isStdioTransport = false;

function safeLog(
  level:
    | 'error'
    | 'debug'
    | 'info'
    | 'notice'
    | 'warning'
    | 'critical'
    | 'alert'
    | 'emergency',
  data: any
): void {
  if (isStdioTransport) {
    // For stdio transport, log to stderr to avoid protocol interference
    console.error(
      `[${level}] ${typeof data === 'object' ? JSON.stringify(data) : data}`
    );
  } else {
    // For other transport types, use the normal logging mechanism
    server.sendLoggingMessage({ level, data });
  }
}

// Add utility function for delay
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function to poll for email search results
async function pollForEmailSearchResults(
  searchId: string,
  maxAttempts = 10,
  intervalMs = 2000
): Promise<EmailSearchResult> {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    
    const response = await apiClient.post<EmailSearchResult>(
      '/bulk-single-searchs/read',
      { id: searchId }
    );
    
    // Check if search is complete
    if (
      response.data.success &&
      response.data.items.length > 0 &&
      !['NONE', 'SCHEDULED', 'IN_PROGRESS'].includes(response.data.items[0].status)
    ) {
      return response.data;
    }
    
    // If we've reached max attempts, return the current result
    if (attempts >= maxAttempts) {
      return response.data;
    }
    
    // Wait before trying again
    await delay(intervalMs);
  }
  
  throw new Error('Max polling attempts reached');
}

// Add retry logic with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  attempt = 1
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const isRateLimit =
      error instanceof Error &&
      (error.message.includes('rate limit') || error.message.includes('429'));

    if (isRateLimit && attempt < CONFIG.retry.maxAttempts) {
      const delayMs = Math.min(
        CONFIG.retry.initialDelay *
          Math.pow(CONFIG.retry.backoffFactor, attempt - 1),
        CONFIG.retry.maxDelay
      );

      safeLog(
        'warning',
        `Rate limit hit for ${context}. Attempt ${attempt}/${CONFIG.retry.maxAttempts}. Retrying in ${delayMs}ms`
      );

      await delay(delayMs);
      return withRetry(operation, context, attempt + 1);
    }

    throw error;
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    FIND_WORK_EMAIL_TOOL,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const startTime = Date.now();
  try {
    const { name, arguments: args } = request.params;

    // Log incoming request with timestamp
    safeLog(
      'info',
      `[${new Date().toISOString()}] Received request for tool: ${name}`
    );

    if (!args) {
      throw new Error('No arguments provided');
    }

    switch (name) {
      case 'icypeas_find_work_email': {
        if (!isFindWorkEmailParams(args)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Invalid arguments for icypeas_find_work_email'
          );
        }

        try {
          const payload = {
            firstname: args.firstname,
            lastname: args.lastname,
            domainOrCompany: args.domainOrCompany
          };

          // Step 1: Initiate the email search
          safeLog('info', 'Initiating email search with payload: ' + JSON.stringify(payload));
          const searchResponse = await withRetry<{data: EmailSearchResponse}>(
            async () => apiClient.post('/email-search', payload),
            'initiate email search'
          );

          if (!searchResponse.data.success || !searchResponse.data.item._id) {
            throw new Error('Failed to initiate email search: ' + JSON.stringify(searchResponse.data));
          }

          const searchId = searchResponse.data.item._id;
          safeLog('info', `Email search initiated with ID: ${searchId}`);

          // Step 2: Poll for results
          safeLog('info', `Polling for results with search ID: ${searchId}`);
          const searchResult = await pollForEmailSearchResults(searchId);

          // Format the response
          let formattedResponse;
          
          if (
            searchResult.success && 
            searchResult.items.length > 0 && 
            searchResult.items[0].results && 
            searchResult.items[0].results.emails && 
            searchResult.items[0].results.emails.length > 0
          ) {
            // Success case with emails found
            formattedResponse = {
              success: true,
              person: {
                firstname: searchResult.items[0].results.firstname,
                lastname: searchResult.items[0].results.lastname,
                fullname: searchResult.items[0].results.fullname,
                gender: searchResult.items[0].results.gender
              },
              emails: searchResult.items[0].results.emails.map(email => ({
                email: email.email,
                certainty: email.certainty,
                provider: email.mxProvider
              })),
              status: searchResult.items[0].status
            };
          } else if (searchResult.items.length > 0) {
            // Search completed but no emails found
            formattedResponse = {
              success: true,
              person: {
                firstname: args.firstname,
                lastname: args.lastname,
                fullname: `${args.firstname} ${args.lastname}`
              },
              emails: [],
              status: searchResult.items[0].status,
              message: "No emails found or search still in progress"
            };
          } else {
            // Something went wrong
            formattedResponse = {
              success: false,
              message: "Failed to retrieve email search results",
              rawResponse: searchResult
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(formattedResponse, null, 2),
              },
            ],
            isError: false,
          };
        } catch (error) {
          const errorMessage = axios.isAxiosError(error)
            ? `API Error: ${error.response?.data?.message || error.message}`
            : `Error: ${error instanceof Error ? error.message : String(error)}`;

          return {
            content: [{ type: 'text', text: errorMessage }],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [
            { type: 'text', text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }
  } catch (error) {
    // Log detailed error information
    safeLog('error', {
      message: `Request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      tool: request.params.name,
      arguments: request.params.arguments,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    // Log request completion with performance metrics
    safeLog('info', `Request completed in ${Date.now() - startTime}ms`);
  }
});

// Server startup
async function runServer() {
  try {
    console.error('Initializing Icypeas MCP Server...');

    const transport = new StdioServerTransport();

    // Detect if we're using stdio transport
    isStdioTransport = transport instanceof StdioServerTransport;
    if (isStdioTransport) {
      console.error(
        'Running in stdio mode, logging will be directed to stderr'
      );
    }

    await server.connect(transport);

    // Now that we're connected, we can send logging messages
    safeLog('info', 'Icypeas MCP Server initialized successfully');
    safeLog(
      'info',
      `Configuration: API URL: ${ICYPEAS_API_URL}`
    );

    console.error('Icypeas MCP Server running on stdio');
  } catch (error) {
    console.error('Fatal error running server:', error);
    process.exit(1);
  }
}

runServer().catch((error: any) => {
  console.error('Fatal error running server:', error);
  process.exit(1);
});
