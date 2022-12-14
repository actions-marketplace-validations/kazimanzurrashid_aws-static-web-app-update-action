import { ReadStream, Stats } from 'fs';

import { PutObjectCommand } from '@aws-sdk/client-s3';

import type {
  ListDistributionsCommandOutput,
  GetInvalidationCommandOutput,
  CreateInvalidationCommandOutput
} from '@aws-sdk/client-cloudfront';

import {
  CreateInvalidationCommand,
  GetInvalidationCommand,
  ListDistributionsCommand
} from '@aws-sdk/client-cloudfront';

interface Input {
  location: string;
  bucket: string;
}

interface RunInput extends Input {
  invalidate?: boolean | string;
  wait: boolean;
  cacheControl: { [key: string]: string | string[] };
  region: string;
}

interface UploadInput extends Input {
  file: string;
  cacheControl?: string;
}

class Action {
  constructor(
    private readonly fs: {
      readdir: (path: string) => Promise<string[]>;
      stat: (path: string) => Promise<Stats>;
      createReadStream: (path: string) => ReadStream;
      join: (...paths: string[]) => string;
    },
    private readonly s3: {
      putObject: (args: PutObjectCommand) => Promise<void>;
    },
    private readonly cf: {
      listDistributions: (
        args: ListDistributionsCommand
      ) => Promise<ListDistributionsCommandOutput>;

      getInvalidation: (
        args: GetInvalidationCommand
      ) => Promise<GetInvalidationCommandOutput>;

      createInvalidation: (
        args: CreateInvalidationCommand
      ) => Promise<CreateInvalidationCommandOutput>;
    },
    private readonly mime: {
      lookup: (filenameOrExt: string) => string | false;
    },
    private readonly glob: {
      match: (path: string, pattern: string | string[]) => Promise<string[]>;
    },
    private readonly log: (message: string) => void
  ) {}

  async run(input: RunInput): Promise<void> {
    const [cacheMap, files] = await Promise.all([
      this.buildCacheMap(input.location, input.cacheControl),
      this.listFiles(input.location)
    ]);

    // eslint-disable-next-line i18n-text/no-en
    this.log(`Uploading to s3 bucket ${input.bucket}`);

    const uploads = files.map(async (file) =>
      this.upload({
        location: input.location,
        bucket: input.bucket,
        cacheControl: cacheMap.get(file),
        file
      })
    );

    await Promise.all(uploads);

    // eslint-disable-next-line i18n-text/no-en
    this.log('Upload completed');

    if (
      typeof input.invalidate === 'undefined' ||
      (input.invalidate || 'false').toString().toLowerCase() === 'false'
    ) {
      return;
    }

    const distributionId =
      input.invalidate.toString().toLowerCase() === 'true'
        ? await this.findDistributionId(input.bucket, input.region)
        : input.invalidate.toString();

    if (!distributionId) {
      throw new Error(
        `Could not find any cloudfront distribution that is associated with s3 bucket ${input.bucket}!`
      );
    }

    await this.invalidateDistribution(distributionId, input.wait);
  }

  private async buildCacheMap(
    path: string,
    cacheControl: { [key: string]: string | string[] }
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    for (const key of Object.keys(cacheControl)) {
      const files = await this.glob.match(path, cacheControl[key]);

      for (const file of files) {
        map.set(this.fs.join(path, file), key);
      }
    }

    return map;
  }

  private async listFiles(path: string): Promise<string[]> {
    const entries = await this.fs.readdir(path);
    const entriesWithStat = await Promise.all(
      entries.map(async (entry) => {
        const full = this.fs.join(path, entry);
        const stat = await this.fs.stat(full);
        return {
          full,
          stat
        };
      })
    );

    const files: string[] = [];
    const directories: string[] = [];

    for (const entry of entriesWithStat) {
      if (entry.stat.isFile()) {
        files.push(entry.full);
      } else if (entry.stat.isDirectory()) {
        directories.push(entry.full);
      }
    }

    const tasks = await Promise.all(
      directories.map(async (directory) => this.listFiles(directory))
    );

    return tasks.reduce((a, c) => [...a, ...c], files);
  }

  private async upload(input: UploadInput): Promise<void> {
    const key = input.file
      .substring(input.location.length - 1)
      .replace(/\\/g, '/');

    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: key,
      Body: this.fs.createReadStream(input.file),
      CacheControl: input.cacheControl,
      ContentType: this.mime.lookup(key) as string
    });

    this.log(`...Uploading ${input.file}`);

    await this.s3.putObject(cmd);

    this.log(`...Uploaded ${input.file}`);
  }

  private async findDistributionId(
    bucket: string,
    region: string
  ): Promise<string | undefined> {
    const normalizedBucket = bucket.toLowerCase();
    const normalizedRegion = region.toLowerCase();

    const bucketWithDomainNames = [
      `${normalizedBucket}.s3.${normalizedRegion}.amazonaws.com`,
      `${normalizedBucket}.s3-website-${normalizedRegion}.amazonaws.com`
    ];

    let nextMarker: string | undefined = undefined;

    do {
      const cmd: ListDistributionsCommand = new ListDistributionsCommand({
        Marker: nextMarker,
        MaxItems: 10
      });

      const result = await this.cf.listDistributions(cmd);

      let match = result.DistributionList?.Items?.find(
        (item) =>
          item.Aliases &&
          item.Aliases.Items &&
          item.Aliases.Items.some((a) => a.toLowerCase() === normalizedBucket)
      );

      if (!match) {
        match = result.DistributionList?.Items?.find(
          (item) =>
            item.Origins &&
            item.Origins.Items &&
            item.Origins.Items.some(
              (o) =>
                o.DomainName &&
                bucketWithDomainNames.includes(o.DomainName.toLowerCase())
            )
        );
      }

      if (match) {
        return match.Id;
      }

      nextMarker = result.DistributionList?.NextMarker;
    } while (nextMarker);

    return undefined;
  }

  private async invalidateDistribution(
    distributionId: string,
    wait: boolean
  ): Promise<void> {
    const poll = async (id: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        setTimeout(async () => {
          const getInvalidationCommand = new GetInvalidationCommand({
            DistributionId: distributionId,
            Id: id
          });

          this.log('...Checking invalidation status');

          try {
            const getInvalidationResult = await this.cf.getInvalidation(
              getInvalidationCommand
            );

            if (
              getInvalidationResult.Invalidation &&
              getInvalidationResult.Invalidation.Status === 'InProgress'
            ) {
              await poll(id);
              return;
            }

            // eslint-disable-next-line i18n-text/no-en
            this.log('Invalidation completed');
            return resolve();
          } catch (error) {
            return reject(error);
          }
        }, 1000 * 20);
      });
    };

    const createInvalidationCommand = new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: process.env.GITHUB_SHA,
        Paths: {
          Quantity: 1,
          Items: ['/*']
        }
      }
    });

    // eslint-disable-next-line i18n-text/no-en
    this.log(`Invalidating cloudfront distribution ${distributionId}`);

    const createInvalidationResult = await this.cf.createInvalidation(
      createInvalidationCommand
    );

    if (
      wait &&
      createInvalidationResult.Invalidation &&
      createInvalidationResult.Invalidation.Id
    ) {
      await poll(createInvalidationResult.Invalidation.Id);
    }
  }
}

export { RunInput, Action };
