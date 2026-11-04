import axios from 'axios';
import { getConnection } from './db/settings.js';

export interface BufferMediaItem {
  type: 'image';
  url: string;
}

export async function fetchBufferChannelDetails(bufferToken: string, channelId: string): Promise<{ network: string; name: string }> {
  const query = `
    query GetChannel($channelId: ChannelId!) {
      channel(input: { id: $channelId }) {
        service
        name
      }
    }
  `;

  const payload = {
    query,
    variables: { channelId }
  };

  const url = 'https://api.buffer.com';

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bufferToken}`
      }
    });

    const data = response.data;
    if (data.errors) {
      throw new Error(data.errors[0].message);
    }

    const channel = data.data?.channel;
    if (!channel || !channel.service) {
      throw new Error('Could not find channel details');
    }

    return { network: channel.service, name: channel.name || channel.service };
  } catch (error: any) {
    console.error('Buffer API error fetching channel details:', error.response?.data || error.message);
    throw new Error(error.response?.data?.errors?.[0]?.message || error.message || 'Failed to fetch Buffer channel details');
  }
}

export async function publishToBuffer(media: BufferMediaItem[], text: string, publishMetadata: any = {}, connectionId: number) {
  const connection = await getConnection(connectionId);
  if (!connection) {
    throw new Error('Connection not found.');
  }
  
  const bufferToken = connection.bufferApiKey;
  const channelId = connection.bufferChannelId;
  const channelNetwork = connection.bufferChannelNetwork || 'instagram';

  if (!bufferToken || !channelId) {
    throw new Error('Buffer API credentials missing.');
  }

  let metadata = publishMetadata || {};
  if (Object.keys(metadata).length === 0 && channelNetwork === 'instagram') {
    metadata = {
      instagram: {
        type: "post",
        shouldShareToFeed: true
      }
    };
  }

  const assets = media.map(m => ({ image: { url: m.url } }));

  const formatGraphQLObject = (obj: any): string => {
    let str = '{';
    for (const [key, value] of Object.entries(obj)) {
      str += `${key}: `;
      if (typeof value === 'object' && value !== null) {
        str += formatGraphQLObject(value);
      } else if (typeof value === 'string') {
        str += value; 
      } else {
        str += value;
      }
      str += ', ';
    }
    str += '}';
    return str;
  };

  const metadataString = Object.keys(metadata).length > 0 
    ? `metadata: ${formatGraphQLObject(metadata)}`
    : '';

  const assetsString = `assets: [${assets.map(a => 
    `{ ${Object.keys(a)[0]}: { url: ${JSON.stringify(Object.values(a)[0].url)} } }`
  ).join(',\n')}]`;

  const query = `
    mutation CreatePost {
      createPost(
        input: {
          text: ${JSON.stringify(text)}
          channelId: ${JSON.stringify(channelId)}
          schedulingType: automatic
          mode: shareNow
          ${metadataString}
          ${assetsString}
        }
      ) {
        ... on PostActionSuccess {
          post {
            id
            text
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  const payload = { query };
  const url = 'https://api.buffer.com';

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bufferToken}`
      }
    });

    const data = response.data;
    if (data.errors) {
      throw new Error(data.errors[0].message);
    }

    const mutationResult = data.data?.createPost;
    if (mutationResult?.message) {
      throw new Error(mutationResult.message);
    }

    return mutationResult?.post;
  } catch (error: any) {
    console.error('Buffer API error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.errors?.[0]?.message || error.message || 'Failed to publish to Buffer');
  }
}

export interface BufferPostStatusResult {
  id: string;
  status: string;
  externalLink?: string | null;
  sentAt?: string | null;
  message?: string;
}

export async function getBufferPostStatus(bufferToken: string, bufferPostId: string): Promise<BufferPostStatusResult> {
  const query = `
    query GetPost {
      post(input: { id: ${JSON.stringify(bufferPostId)} }) {
        id
        status
        externalLink
        sentAt
      }
    }
  `;

  const payload = { query };

  const url = 'https://api.buffer.com';

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bufferToken}`
      }
    });

    const data = response.data;
    if (data.errors) {
      throw new Error(data.errors[0].message);
    }

    const post = data.data?.post;
    if (!post) {
      throw new Error('Post not found in Buffer');
    }

    return {
      id: post.id,
      status: post.status,
      externalLink: post.externalLink || null,
      sentAt: post.sentAt || null,
    };
  } catch (error: any) {
    console.error('Buffer getBufferPostStatus error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.errors?.[0]?.message || error.message || 'Failed to fetch Buffer post status');
  }
}
