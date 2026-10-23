-- SHP-T-15.4: an API token's scope may name adopted stacks as well as apps (SHP-ADR-010, SHP-ADR-011).
-- CreateTable
CREATE TABLE "api_token_stack" (
    "token_id" UUID NOT NULL,
    "stack_id" UUID NOT NULL,

    CONSTRAINT "api_token_stack_pkey" PRIMARY KEY ("token_id","stack_id")
);

-- AddForeignKey
ALTER TABLE "api_token_stack" ADD CONSTRAINT "api_token_stack_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_stack" ADD CONSTRAINT "api_token_stack_stack_id_fkey" FOREIGN KEY ("stack_id") REFERENCES "stack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

